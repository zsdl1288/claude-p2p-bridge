#pragma once
#include "update-verify.hpp"
#include "single-instance.hpp"
#include "job-lifecycle.hpp"
#include <optional>
#include <exception>

namespace DesktopUpdate {
inline constexpr wchar_t ReadyEventPrefix[] = L"Local\\ClaudeBridge.UpdateReady.";
inline constexpr wchar_t StagingPrefix[] = L"ClaudeBridgeUpdate-";
struct InstallRequest {
    fs::path staging, target, candidate;
    std::string sha256, version;
    std::vector<std::wstring> arguments;
};

inline DesktopSingleInstance::Names InstallInstanceNames() {
#ifdef BRIDGE_DESKTOP_TEST_NAMESPACE
    return DesktopSingleInstance::TestNames(BRIDGE_DESKTOP_TEST_NAMESPACE);
#else
    return {};
#endif
}
// Source-level injection for isolated executables. There are no production
// arguments or environment variables which change locks, timeouts or APIs.
struct InstallRuntime {
    DesktopSingleInstance::Names names = InstallInstanceNames();
    DWORD parentExitMs = 120000, applicationReadyMs = 90000;
    bool quiet = false;
    std::function<BOOL(LPCWSTR,LPCWSTR,LPCWSTR,DWORD)> replace;
    std::function<void()> beforeLaunch;
};

namespace InstallDetail {
inline std::wstring Token() {
    unsigned char bytes[32];
    if (BCryptGenRandom(nullptr, bytes, sizeof(bytes), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0)
        throw std::runtime_error("无法生成安全更新标识");
    constexpr wchar_t hex[] = L"0123456789abcdef"; std::wstring token;
    for (auto value : bytes) { token += hex[value >> 4]; token += hex[value & 15]; }
    return token;
}
inline bool TokenValid(const std::wstring& token) {
    return token.size() == 64 && token.find_first_not_of(L"0123456789abcdef") == std::wstring::npos;
}
inline fs::path LocalPath(const fs::path& input) {
    auto text = input.wstring();
    if (!input.is_absolute() || text.size() > 30000 || text.find(L'\0') != std::wstring::npos
        || text.size() < 3 || text[1] != L':' || !((text[0] >= L'A' && text[0] <= L'Z') || (text[0] >= L'a' && text[0] <= L'z'))
        || text.find(L':', 2) != std::wstring::npos)
        throw std::runtime_error("自动更新只支持本地绝对路径");
    return input.lexically_normal();
}
inline bool SamePath(const fs::path& a, const fs::path& b) {
    const auto left = LocalPath(a).wstring(), right = LocalPath(b).wstring();
    return CompareStringOrdinal(left.c_str(), -1, right.c_str(), -1, TRUE) == CSTR_EQUAL;
}
inline fs::path Executable() {
    std::wstring path(32768, L'\0'); auto count = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
    if (!count || count >= path.size()) throw std::runtime_error("无法读取客户端路径");
    path.resize(count); return LocalPath(path);
}
inline fs::path ProcessImage(HANDLE process) {
    std::wstring path(32768, L'\0'); DWORD count = static_cast<DWORD>(path.size());
    if (!QueryFullProcessImageNameW(process, 0, path.data(), &count)) throw std::runtime_error("无法核对更新父进程");
    path.resize(count); return LocalPath(path);
}
inline uint64_t Created(HANDLE process) {
    FILETIME created{}, exited{}, kernel{}, user{};
    if (!GetProcessTimes(process, &created, &exited, &kernel, &user)) throw std::runtime_error("无法核对更新进程身份");
    return (uint64_t(created.dwHighDateTime) << 32) | created.dwLowDateTime;
}
inline Json Identity(HANDLE file) {
    BY_HANDLE_FILE_INFORMATION info{};
    if (!GetFileInformationByHandle(file, &info)) throw std::runtime_error("无法读取原文件身份");
    return {{"volume", info.dwVolumeSerialNumber}, {"index", (uint64_t(info.nFileIndexHigh) << 32) | info.nFileIndexLow}};
}
inline void NoReparse(const fs::path& input, bool leafMayBeMissing = false) {
    const auto path = LocalPath(input); auto current = path.root_path();
    for (const auto& component : path.relative_path()) {
        current /= component; const auto attributes = GetFileAttributesW(current.c_str());
        if (attributes == INVALID_FILE_ATTRIBUTES) {
            if (leafMayBeMissing && SamePath(current, path) && GetLastError() == ERROR_FILE_NOT_FOUND) return;
            throw std::runtime_error("更新路径不存在或无法访问");
        }
        if (attributes & FILE_ATTRIBUTE_REPARSE_POINT) throw std::runtime_error("自动更新拒绝链接或重解析路径");
    }
}
inline std::unique_ptr<KernelHandle> PinDirectory(const fs::path& path) {
    NoReparse(path);
    auto result = std::make_unique<KernelHandle>(CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (result->value == INVALID_HANDLE_VALUE) throw std::runtime_error("无法锁定更新目录");
    BY_HANDLE_FILE_INFORMATION info{};
    if (!GetFileInformationByHandle(result->value, &info) || !(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)
        || (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) throw std::runtime_error("更新目录无效");
    return result;
}
inline std::vector<std::unique_ptr<KernelHandle>> PinParents(const fs::path& file) {
    std::vector<std::unique_ptr<KernelHandle>> pins; auto parent = LocalPath(file).parent_path(); auto current = parent.root_path();
    pins.push_back(PinDirectory(current));
    for (const auto& part : parent.relative_path()) { current /= part; pins.push_back(PinDirectory(current)); }
    return pins;
}
inline std::string ReadSmall(const fs::path& path) {
    KernelHandle file(VerifyDetail::OpenLocked(path)); LARGE_INTEGER size{};
    if (!GetFileSizeEx(file.value, &size) || size.QuadPart < 0 || size.QuadPart > 65536) throw std::runtime_error("更新请求文件无效");
    std::string value(static_cast<size_t>(size.QuadPart), '\0'); DWORD read = 0;
    if (!ReadFile(file.value, value.data(), static_cast<DWORD>(value.size()), &read, nullptr) || read != value.size())
        throw std::runtime_error("无法读取更新请求");
    return value;
}
inline void WriteNew(const fs::path& path, const std::string& data) {
    KernelHandle file(CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
    if (file.value == INVALID_HANDLE_VALUE) throw std::runtime_error("无法准备更新文件");
    DWORD written = 0;
    if (!WriteFile(file.value, data.data(), static_cast<DWORD>(data.size()), &written, nullptr) || written != data.size() || !FlushFileBuffers(file.value))
        throw std::runtime_error("无法完整保存更新文件");
}
inline std::wstring StagingToken(const fs::path& directory) {
    const auto path = LocalPath(directory); NoReparse(path); const auto name = path.filename().wstring();
    if (!name.starts_with(StagingPrefix) || !TokenValid(name.substr(std::size(StagingPrefix) - 1))) throw std::runtime_error("更新临时目录不属于客户端");
    const auto token = name.substr(std::size(StagingPrefix) - 1);
    if (ReadSmall(path / L".bridge-update-owner") != Utf8(token)) throw std::runtime_error("更新临时目录标记无效");
    return token;
}
inline void CheckCancelled(const std::atomic<bool>* cancel) {
    if (cancel && cancel->load()) throw std::runtime_error("更新已取消");
}
inline void CopyChecked(const fs::path& source,const fs::path& destination,const std::function<void()>& check) {
    check();
    struct Progress { const std::function<void()>& check; std::exception_ptr failure; } progress{check,{}};
    const auto callback=[](LARGE_INTEGER,LARGE_INTEGER,LARGE_INTEGER,LARGE_INTEGER,DWORD,DWORD,HANDLE,HANDLE,LPVOID parameter)->DWORD {
        auto& state=*static_cast<Progress*>(parameter);
        try {state.check();return PROGRESS_CONTINUE;}catch(...){state.failure=std::current_exception();return PROGRESS_CANCEL;}
    };
    // PROGRESS_CANCEL removes a partially copied destination, so ordinary
    // cancellation does not strand a same-directory executable fragment.
    const auto copied=CopyFileExW(source.c_str(),destination.c_str(),callback,&progress,nullptr,COPY_FILE_FAIL_IF_EXISTS);
    if(progress.failure)std::rethrow_exception(progress.failure);
    if(!copied)throw std::runtime_error("无法复制更新文件 (Windows "+std::to_string(GetLastError())+")");
}
inline std::wstring Command(const fs::path& executable, const std::vector<std::wstring>& arguments) {
    auto command = QuoteArgument(executable.wstring());
    for (const auto& argument : arguments) {
        if (argument.find(L'\0') != std::wstring::npos) throw std::runtime_error("更新启动参数无效");
        command += L" " + QuoteArgument(argument);
    }
    if (command.size() >= 30000) throw std::runtime_error("更新启动参数过长");
    return command;
}
inline BOOL Replace(const InstallRuntime& runtime, const fs::path& target, const fs::path& replacement, const fs::path& backup) {
    if (runtime.replace) return runtime.replace(target.c_str(), replacement.c_str(), backup.empty() ? nullptr : backup.c_str(), 0);
    // REPLACEFILE_WRITE_THROUGH is explicitly unsupported by Windows.
    return ReplaceFileW(target.c_str(), replacement.c_str(), backup.empty() ? nullptr : backup.c_str(), 0, nullptr, nullptr);
}
inline bool Exists(const fs::path& path) { return GetFileAttributesW(path.c_str()) != INVALID_FILE_ATTRIBUTES; }
inline bool HasHash(const fs::path& path, const std::string& hash) {
    try { NoReparse(path); return FileHash(path) == hash; } catch (...) { return false; }
}
inline void DeleteKnown(const fs::path& path, const std::string& hash) {
    if (HasHash(path, hash)) DeleteFileW(path.c_str());
}
inline void Restore(const InstallRuntime& runtime, const fs::path& target, const fs::path& backup,
                    const std::string& oldHash, const std::string& newHash) {
    if (HasHash(target, oldHash)) return;
    if (!HasHash(backup, oldHash)) throw std::runtime_error("旧版备份校验失败，已保留现有文件供恢复");
    NoReparse(target.parent_path());
    if (Exists(target)) {
        if (!HasHash(target, newHash)) throw std::runtime_error("目标文件已被其他程序修改，已保留旧版备份");
        Replace(runtime, target, backup, {});
    }
    // 1177 can leave target absent and the original at the backup name.
    if (!Exists(target) && HasHash(backup, oldHash)) MoveFileW(backup.c_str(), target.c_str());
    if (!HasHash(target, oldHash)) throw std::runtime_error("无法恢复旧版，请从保留的备份恢复");
}
inline void LaunchOld(const fs::path& target, const std::vector<std::wstring>& arguments) {
    auto command = Command(target, arguments); STARTUPINFOW startup{}; startup.cb = sizeof(startup); PROCESS_INFORMATION process{};
    if (!CreateProcessW(target.c_str(), command.data(), nullptr, nullptr, FALSE, 0, nullptr, target.parent_path().c_str(), &startup, &process))
        throw std::runtime_error("旧版文件已恢复，但未能自动重新启动");
    CloseHandle(process.hThread); CloseHandle(process.hProcess);
}
inline HANDLE ParseHandle(const std::wstring& value) {
    if (value.empty() || value.size() > 20 || value.find_first_not_of(L"0123456789") != std::wstring::npos) throw std::runtime_error("更新句柄无效");
    auto number = std::stoull(value); if (!number || number >= std::numeric_limits<uintptr_t>::max()) throw std::runtime_error("更新句柄无效");
    auto handle = reinterpret_cast<HANDLE>(static_cast<uintptr_t>(number)); DWORD flags = 0;
    if (!GetHandleInformation(handle, &flags)) throw std::runtime_error("更新句柄不可用");
    return handle;
}
inline std::wstring HandleText(HANDLE handle) { return std::to_wstring(reinterpret_cast<uintptr_t>(handle)); }
inline Json RequestJson(const InstallRequest& request, HANDLE parent, const std::string& oldHash, const Json& identity) {
    Json args = Json::array(); for (const auto& value : request.arguments) args.push_back(Utf8(value));
    return {{"target",Utf8(request.target.wstring())},{"candidate",Utf8(request.candidate.wstring())},{"sha256",request.sha256},
        {"version",request.version},{"oldSha256",oldHash},{"identity",identity},{"parentPid",GetProcessId(parent)},
        {"parentCreated",Created(parent)},{"arguments",args}};
}
struct CleanupInfo { DWORD pid; uint64_t created; wchar_t staging[32768]; };
} // namespace InstallDetail

inline fs::path CreateStaging(const fs::path& base = {}) {
    fs::path directory = base;
    if (directory.empty()) { std::wstring temp(32768,L'\0'); const auto count = GetTempPathW(static_cast<DWORD>(temp.size()),temp.data());
        if (!count || count >= temp.size()) throw std::runtime_error("无法读取临时目录");
        temp.resize(count); directory = temp; }
    directory = InstallDetail::LocalPath(directory); InstallDetail::NoReparse(directory);
    const auto token = InstallDetail::Token(); auto staging = directory / (std::wstring(StagingPrefix) + token);
    if (!CreateDirectoryW(staging.c_str(), nullptr)) throw std::runtime_error("无法创建独立更新目录");
    try { InstallDetail::WriteNew(staging / L".bridge-update-owner",Utf8(token)); } catch (...) { RemoveDirectoryW(staging.c_str()); throw; }
    return staging;
}
inline void CleanupStaging(const fs::path& directory) {
    if (directory.empty()) return;
    InstallDetail::StagingToken(directory);
    std::vector<fs::path> files;
    for (const auto& item : fs::directory_iterator(directory)) {
        const auto attributes = GetFileAttributesW(item.path().c_str());
        if (attributes == INVALID_FILE_ATTRIBUTES || attributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY))
            throw std::runtime_error("更新目录包含未知链接或子目录，已保留");
        if (item.path().filename() != L".bridge-update-owner") files.push_back(item.path());
    }
    bool removed = true; for (const auto& file : files) if (!DeleteFileW(file.c_str())) removed = false;
    // The running helper may remain locked. Keep its ownership marker so a
    // later explicit cleanup can safely remove this same directory.
    if (removed) { DeleteFileW((directory / L".bridge-update-owner").c_str()); RemoveDirectoryW(directory.c_str()); }
}
inline bool ValidReadyEvent(const std::wstring& name) {
    return name.starts_with(ReadyEventPrefix) && InstallDetail::TokenValid(name.substr(std::size(ReadyEventPrefix) - 1));
}
inline void SignalUpdateReady(const std::wstring& name) {
    if (!ValidReadyEvent(name)) throw std::runtime_error("更新就绪事件无效");
    KernelHandle committed(OpenEventW(SYNCHRONIZE,FALSE,(name+L".Committed").c_str()));
    if (!committed.value) throw std::runtime_error("无法打开更新提交事件");
    // Bind cleanup to the exact helper process while it is still alive. The
    // random named mapping is only a handoff for this update, never a scan.
    KernelHandle mapping(OpenFileMappingW(FILE_MAP_READ,FALSE,(name+L".Cleanup").c_str()));
    if (!mapping.value) throw std::runtime_error("无法打开更新清理信息");
    const auto view=static_cast<const InstallDetail::CleanupInfo*>(MapViewOfFile(mapping.value,FILE_MAP_READ,0,0,sizeof(InstallDetail::CleanupInfo)));
    if (!view) throw std::runtime_error("无法读取更新清理信息");
    const auto info=*view; UnmapViewOfFile(view);
    if (info.staging[32767]!=L'\0') throw std::runtime_error("更新清理路径无效");
    const fs::path staging=InstallDetail::LocalPath(info.staging); InstallDetail::StagingToken(staging);
    auto helper=std::make_shared<KernelHandle>(OpenProcess(SYNCHRONIZE|PROCESS_QUERY_LIMITED_INFORMATION,FALSE,info.pid));
    if(!helper->value||InstallDetail::Created(helper->value)!=info.created||!InstallDetail::SamePath(InstallDetail::ProcessImage(helper->value),staging/L"helper.exe"))
        throw std::runtime_error("更新清理进程身份无效");
    KernelHandle event(OpenEventW(EVENT_MODIFY_STATE,FALSE,name.c_str()));
    if (!event.value || !SetEvent(event.value)) throw std::runtime_error("无法确认新版启动成功");
    if (WaitForSingleObject(committed.value,15000)!=WAIT_OBJECT_0) throw std::runtime_error("等待新版提交确认超时");
    try {
        std::thread([helper,staging]{
            if(WaitForSingleObject(helper->value,120000)==WAIT_OBJECT_0)try{CleanupStaging(staging);}catch(...){}
        }).detach();
    } catch (...) { /* Cleanup cannot turn a committed update into a failure. */ }
}

inline void LaunchInstall(const InstallRequest& input, const std::atomic<bool>* cancel = nullptr, DWORD readyTimeoutMs = 15000) {
    using namespace InstallDetail; CheckCancelled(cancel);
    InstallRequest request = input; request.staging=LocalPath(request.staging); request.target=LocalPath(request.target); request.candidate=LocalPath(request.candidate);
    StagingToken(request.staging); NoReparse(request.target); NoReparse(request.candidate);
    if (!SamePath(request.target,Executable()) || !SamePath(request.candidate.parent_path(),request.staging)) throw std::runtime_error("更新目标必须是当前客户端，候选必须位于独立更新目录");
    for (const auto& argument : request.arguments) if (argument.starts_with(L"--update-")) throw std::runtime_error("重启参数包含旧更新状态");
    Command(request.target,request.arguments);
    auto pins=PinParents(request.target); auto stagingPin=PinDirectory(request.staging);
    // Probe delete authorization before our own read-only lock. The helper
    // separately prepares a same-directory replacement before signalling ready.
    { KernelHandle permission(CreateFileW(request.target.c_str(),DELETE|READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,
        nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
      if (permission.value==INVALID_HANDLE_VALUE || (GetFileAttributesW(request.target.c_str())&FILE_ATTRIBUTE_READONLY)) throw std::runtime_error("客户端文件不可替换或被其他程序锁定"); }
    KernelHandle original(VerifyDetail::OpenLocked(request.target)); KernelHandle candidate(VerifyDetail::OpenLocked(request.candidate));
    VerifyExecutable(request.candidate,request.sha256,request.version,[&]{CheckCancelled(cancel);});
    const auto oldHash=VerifyDetail::FileHash(original.value); const auto identity=Identity(original.value);
    const auto helper=request.staging/L"helper.exe", manifest=request.staging/L"request.json";
    CopyChecked(request.target,helper,[&]{CheckCancelled(cancel);});
    if (FileHash(helper)!=oldHash) throw std::runtime_error("无法准备独立更新程序");
    KernelHandle parent,ready,abort;
    if (!DuplicateHandle(GetCurrentProcess(),GetCurrentProcess(),GetCurrentProcess(),&parent.value,SYNCHRONIZE|PROCESS_QUERY_LIMITED_INFORMATION,TRUE,0)) throw std::runtime_error("无法绑定当前客户端进程");
    SECURITY_ATTRIBUTES inherit{sizeof(inherit),nullptr,TRUE}; ready.reset(CreateEventW(&inherit,TRUE,FALSE,nullptr)); abort.reset(CreateEventW(&inherit,TRUE,FALSE,nullptr));
    if (!ready.value||!abort.value) throw std::runtime_error("无法准备更新交接事件");
    WriteNew(manifest,RequestJson(request,parent.value,oldHash,identity).dump());
    auto command=Command(helper,{L"--update-install",manifest.wstring(),L"--update-parent-handle",HandleText(parent.value),L"--update-helper-ready-handle",HandleText(ready.value),L"--update-abort-handle",HandleText(abort.value)});
    SIZE_T bytes=0; InitializeProcThreadAttributeList(nullptr,1,0,&bytes); std::vector<unsigned char> storage(bytes);
    auto attributes=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
    if (!InitializeProcThreadAttributeList(attributes,1,0,&bytes)) throw std::runtime_error("无法准备更新进程属性");
    struct AttributeCleanup { LPPROC_THREAD_ATTRIBUTE_LIST value; ~AttributeCleanup(){DeleteProcThreadAttributeList(value);} } cleanup{attributes};
    HANDLE allowed[]{parent.value,ready.value,abort.value};
    if (!UpdateProcThreadAttribute(attributes,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,allowed,sizeof(allowed),nullptr,nullptr)) throw std::runtime_error("无法限定更新进程继承句柄");
    STARTUPINFOEXW startup{}; startup.StartupInfo.cb=sizeof(startup); startup.StartupInfo.dwFlags=STARTF_USESHOWWINDOW; startup.StartupInfo.wShowWindow=SW_HIDE; startup.lpAttributeList=attributes;
    PROCESS_INFORMATION process{};
    if (!CreateProcessW(helper.c_str(),command.data(),nullptr,nullptr,TRUE,EXTENDED_STARTUPINFO_PRESENT|CREATE_NO_WINDOW,nullptr,request.staging.c_str(),&startup.StartupInfo,&process)) throw std::runtime_error("无法启动独立更新程序");
    KernelHandle child(process.hProcess), thread(process.hThread); const auto began=GetTickCount64();
    try {
        for (;;) { CheckCancelled(cancel); HANDLE waits[]{ready.value,child.value}; const auto state=WaitForMultipleObjects(2,waits,FALSE,100);
            if (state==WAIT_OBJECT_0) { CheckCancelled(cancel); if (WaitForSingleObject(child.value,0)!=WAIT_TIMEOUT) throw std::runtime_error("更新程序意外退出"); return; }
            if (state==WAIT_OBJECT_0+1) { std::string message="更新程序未能完成准备"; try {message=ReadSmall(request.staging/L"error.txt");} catch(...){} throw std::runtime_error(message); }
            if (state==WAIT_FAILED || GetTickCount64()-began>=readyTimeoutMs) throw std::runtime_error("更新准备超时，当前客户端保持运行");
        }
    } catch (...) {
        SetEvent(abort.value);
        // Give the helper its normal cancellation path before using our own
        // process handle to stop an unresponsive preparation.
        if (WaitForSingleObject(child.value,3000)==WAIT_TIMEOUT) {TerminateProcess(child.value,1);WaitForSingleObject(child.value,5000);}
        const auto token=StagingToken(request.staging);
        DeleteKnown(request.target.parent_path()/(L".bridge-update-"+token+L".new.exe"),request.sha256);
        throw;
    }
}

namespace InstallDetail {
inline int Run(const fs::path& requestPath,HANDLE parent,HANDLE helperReady,HANDLE abort,const InstallRuntime& runtime) {
    const auto staging=LocalPath(requestPath).parent_path(); const auto token=StagingToken(staging); auto stagingPin=PinDirectory(staging);
    const auto data=Json::parse(ReadSmall(requestPath)); InstallRequest request{staging,LocalPath(Wide(data.at("target").get<std::string>())),LocalPath(Wide(data.at("candidate").get<std::string>())),data.at("sha256").get<std::string>(),data.at("version").get<std::string>(),{}};
    for (const auto& argument:data.at("arguments")) request.arguments.push_back(Wide(argument.get<std::string>()));
    const auto oldHash=data.at("oldSha256").get<std::string>();
    if (!ValidHash(oldHash)||GetProcessId(parent)!=data.at("parentPid").get<DWORD>()||Created(parent)!=data.at("parentCreated").get<uint64_t>()
        || !SamePath(ProcessImage(parent),request.target)||DesktopSingleInstance::ProcessSid(parent)!=DesktopSingleInstance::ProcessSid(GetCurrentProcess())
        || !SamePath(Executable(),staging/L"helper.exe")||FileHash(Executable())!=oldHash||!SamePath(request.candidate.parent_path(),staging))
        throw std::runtime_error("更新进程与原客户端身份不匹配");
    for(const auto& argument:request.arguments)if(argument.starts_with(L"--update-"))throw std::runtime_error("更新重启参数无效");
    auto parents=PinParents(request.target);NoReparse(request.target);NoReparse(request.candidate);
    KernelHandle original(VerifyDetail::OpenLocked(request.target)),candidate(VerifyDetail::OpenLocked(request.candidate));
    if(Identity(original.value)!=data.at("identity")||VerifyDetail::FileHash(original.value)!=oldHash)throw std::runtime_error("原客户端文件已变化");
    const auto check=[&]{if(WaitForSingleObject(abort,0)==WAIT_OBJECT_0)throw std::runtime_error("更新已取消");};
    VerifyExecutable(request.candidate,request.sha256,request.version,check);
    const auto pending=request.target.parent_path()/(L".bridge-update-"+token+L".new.exe");
    const auto backup=request.target.parent_path()/(L".bridge-update-"+token+L".backup.exe");
    if(Exists(pending)||Exists(backup))throw std::runtime_error("更新暂存文件已存在");
    bool parentExited=false,replaced=false,success=false,instanceOwned=false;std::unique_ptr<DesktopSingleInstance::Instance> instance;
    KernelHandle pendingLock;
    try {
        CopyChecked(request.candidate,pending,check);
        {KernelHandle flush(CreateFileW(pending.c_str(),GENERIC_WRITE,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr));if(flush.value==INVALID_HANDLE_VALUE||!FlushFileBuffers(flush.value))throw std::runtime_error("无法保存安装目录中的新版");}
        pendingLock.reset(VerifyDetail::OpenLocked(pending));
        VerifyExecutable(pending,request.sha256,request.version,check);check();
        if(!SetEvent(helperReady))throw std::runtime_error("无法确认更新准备完成");
        HANDLE waits[]{abort,parent};const auto state=WaitForMultipleObjects(2,waits,FALSE,runtime.parentExitMs);
        if(state!=WAIT_OBJECT_0+1)throw std::runtime_error(state==WAIT_OBJECT_0?"更新已取消":"等待原客户端退出超时");
        parentExited=true;check();
        instance=std::make_unique<DesktopSingleInstance::Instance>(runtime.names);
        instanceOwned=instance->TryAcquire();
        if(!instanceOwned)throw std::runtime_error("其他客户端已启动，未替换文件");
        if(Identity(original.value)!=data.at("identity")||VerifyDetail::FileHash(original.value)!=oldHash)throw std::runtime_error("原客户端身份已变化");
        if(VerifyDetail::FileHash(pendingLock.value)!=request.sha256||Exists(backup))throw std::runtime_error("更新暂存文件已变化");
        original.reset();candidate.reset();pendingLock.reset();NoReparse(request.target);NoReparse(pending);check();
        const auto applied=Replace(runtime,request.target,pending,backup);const auto replaceError=GetLastError();
        replaced=HasHash(backup,oldHash)||HasHash(request.target,request.sha256);
        if(!applied)throw std::runtime_error("替换客户端失败 (Windows "+std::to_string(replaceError)+")");
        VerifyExecutable(request.target,request.sha256,request.version,check);
        const auto eventName=std::wstring(ReadyEventPrefix)+Token();KernelHandle ready(CreateEventW(nullptr,TRUE,FALSE,eventName.c_str()));
        if(!ready.value||GetLastError()==ERROR_ALREADY_EXISTS)throw std::runtime_error("无法创建新版确认事件");
        KernelHandle committed(CreateEventW(nullptr,TRUE,FALSE,(eventName+L".Committed").c_str()));
        if(!committed.value||GetLastError()==ERROR_ALREADY_EXISTS)throw std::runtime_error("无法创建新版提交事件");
        KernelHandle mapping(CreateFileMappingW(INVALID_HANDLE_VALUE,nullptr,PAGE_READWRITE,0,sizeof(CleanupInfo),(eventName+L".Cleanup").c_str()));
        if(!mapping.value||GetLastError()==ERROR_ALREADY_EXISTS)throw std::runtime_error("无法创建更新清理信息");
        auto cleanupInfo=static_cast<CleanupInfo*>(MapViewOfFile(mapping.value,FILE_MAP_WRITE,0,0,sizeof(CleanupInfo)));
        if(!cleanupInfo)throw std::runtime_error("无法准备更新清理信息");
        *cleanupInfo={};cleanupInfo->pid=GetCurrentProcessId();cleanupInfo->created=Created(GetCurrentProcess());
        const auto stagingText=staging.wstring();std::copy(stagingText.begin(),stagingText.end(),cleanupInfo->staging);UnmapViewOfFile(cleanupInfo);
        auto args=request.arguments;args.push_back(L"--update-ready-event");args.push_back(eventName);auto command=Command(request.target,args);
        KernelHandle job(CreateJobObjectW(nullptr,nullptr));if(!job.value)throw std::runtime_error("无法隔离新版试启动");
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if(!SetInformationJobObject(job.value,JobObjectExtendedLimitInformation,&limits,sizeof(limits)))throw std::runtime_error("无法保护新版试启动");
        STARTUPINFOW startup{};startup.cb=sizeof(startup);PROCESS_INFORMATION process{};
        if(runtime.beforeLaunch)runtime.beforeLaunch();
        if(!CreateProcessW(request.target.c_str(),command.data(),nullptr,nullptr,FALSE,CREATE_SUSPENDED,nullptr,request.target.parent_path().c_str(),&startup,&process))throw std::runtime_error("新版启动失败");
        KernelHandle child(process.hProcess),thread(process.hThread);
        if(!AssignProcessToJobObject(job.value,child.value)){TerminateProcess(child.value,1);WaitForSingleObject(child.value,INFINITE);throw std::runtime_error("无法隔离新版进程");}
        instance.reset();instanceOwned=false;
        try {
            if(ResumeThread(thread.value)==DWORD(-1))throw std::runtime_error("无法运行新版");
            HANDLE started[]{ready.value,child.value};const auto result=WaitForMultipleObjects(2,started,FALSE,runtime.applicationReadyMs);
            if(result!=WAIT_OBJECT_0||WaitForSingleObject(child.value,0)!=WAIT_TIMEOUT)throw std::runtime_error("新版未能确认引擎就绪");
            limits.BasicLimitInformation.LimitFlags=0;
            if(!SetInformationJobObject(job.value,JobObjectExtendedLimitInformation,&limits,sizeof(limits)))throw std::runtime_error("无法提交新版启动");
            // This is the irrevocable commit point. No later cleanup error may
            // terminate the healthy client or restore its executable.
            success=true;SetEvent(committed.value);
        }catch(...){DrainOwnedJob(job.value,child.value);throw;}
        DeleteKnown(backup,oldHash);DeleteKnown(pending,request.sha256);
    }catch(...){
        const auto failure=std::current_exception();original.reset();candidate.reset();pendingLock.reset();
        if(success)return 0;
        if(parentExited){
            if(!instanceOwned){instance.reset();instance=std::make_unique<DesktopSingleInstance::Instance>(runtime.names);instanceOwned=instance->TryAcquire();}
            if(!instanceOwned)throw std::runtime_error("其他客户端正在运行，未终止其他实例。若已生成旧版备份，位置："+Utf8(backup.wstring()));
            if(replaced||HasHash(backup,oldHash)){
                try{Restore(runtime,request.target,backup,oldHash,request.sha256);}
                catch(const std::exception& error){throw std::runtime_error(std::string(error.what())+"。旧版备份位置："+Utf8(backup.wstring()));}
            }
            if(!HasHash(request.target,oldHash))throw std::runtime_error("旧版文件需要手动恢复，备份位置："+Utf8(backup.wstring()));
            instance.reset();LaunchOld(request.target,request.arguments);
        }
        DeleteKnown(pending,request.sha256);std::rethrow_exception(failure);
    }
    if(success){stagingPin.reset();parents.clear();try{CleanupStaging(staging);}catch(...){}return 0;}
    return 1;
}
} // namespace InstallDetail

inline std::optional<int> HandleInstall(const std::vector<std::wstring>& arguments,const InstallRuntime& runtime={}) {
    if(arguments.empty()||arguments[0]!=L"--update-install")return std::nullopt;
    fs::path staging;bool parentGone=false;KernelHandle parent,ready,abort;
    try{
        if(arguments.size()!=8||arguments[2]!=L"--update-parent-handle"||arguments[4]!=L"--update-helper-ready-handle"||arguments[6]!=L"--update-abort-handle")throw std::runtime_error("更新程序参数无效");
        parent.reset(InstallDetail::ParseHandle(arguments[3]));ready.reset(InstallDetail::ParseHandle(arguments[5]));abort.reset(InstallDetail::ParseHandle(arguments[7]));
        const auto request=InstallDetail::LocalPath(arguments[1]);staging=request.parent_path();InstallDetail::StagingToken(staging);
        return InstallDetail::Run(request,parent.value,ready.value,abort.value,runtime);
    }catch(const std::exception& error){
        parentGone=parent.value&&WaitForSingleObject(parent.value,0)==WAIT_OBJECT_0;
        try{InstallDetail::StagingToken(staging);InstallDetail::WriteNew(staging/L"error.txt",error.what());}catch(...){}
        if(parentGone&&!runtime.quiet)MessageBoxW(nullptr,Wide(error.what()).c_str(),L"客户端更新未完成",MB_OK|MB_ICONERROR);
        return 1;
    }
}
} // namespace DesktopUpdate
