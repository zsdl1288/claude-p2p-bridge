#include "../native/desktop/single-instance.hpp"
#include "../native/desktop/job-lifecycle.hpp"
#include <iostream>

namespace {
constexpr UINT RESTORE = WM_APP + 3;
std::wstring quitFile;
void CheckMutexRelease(const DesktopSingleInstance::Names& names) {
    std::exception_ptr failure;
    bool acquired = false;
    KernelHandle observer;
    {
        DesktopSingleInstance::Instance owner(names);
        if (!owner.TryAcquire()) throw std::runtime_error("Cannot acquire isolated mutex fixture");
        const auto mutexName = names.mutexPrefix + DesktopSingleInstance::ProcessSid(GetCurrentProcess());
        observer.reset(OpenMutexW(SYNCHRONIZE, FALSE, mutexName.c_str()));
        if (!observer.value) throw std::runtime_error(WindowsError("Observe isolated mutex fixture"));
        std::thread contender([&] {
            try { DesktopSingleInstance::Instance instance(names); acquired = instance.TryAcquire(); }
            catch (...) { failure = std::current_exception(); }
        });
        contender.join();
        if (failure) std::rethrow_exception(failure);
        if (acquired) throw std::runtime_error("Another thread acquired the live owner's mutex");
    }
    // Keep the observer handle alive as well: closing the last object handle
    // would delete the named mutex and conceal a missing ReleaseMutex. Both
    // owning threads stay alive beyond Instance destruction so abandonment
    // cannot conceal it either.
    std::atomic<bool> ready = false, stop = false;
    std::thread successor([&] {
        try { DesktopSingleInstance::Instance instance(names); acquired = instance.TryAcquire(); }
        catch (...) { failure = std::current_exception(); }
        ready = true;
        while (!stop) Sleep(1);
    });
    while (!ready) Sleep(1);
    try {
        if (failure) std::rethrow_exception(failure);
        if (!acquired) throw std::runtime_error("Instance destruction retained the first thread's mutex ownership");
        DesktopSingleInstance::Instance instance(names);
        if (!instance.TryAcquire()) throw std::runtime_error("Instance destruction retained the second thread's mutex ownership");
    } catch (...) { failure = std::current_exception(); }
    stop = true; successor.join();
    if (failure) std::rethrow_exception(failure);
}
HANDLE SleepingChild(HANDLE job) {
    wchar_t file[32768]; const auto length = GetModuleFileNameW(nullptr, file, 32768);
    if (!length || length >= 32768) throw std::runtime_error("Cannot locate fixture executable");
    auto command = QuoteArgument(std::wstring(file, length)) + L" --job-sleeper";
    STARTUPINFOW startup{}; startup.cb = sizeof(startup); PROCESS_INFORMATION process{};
    if (!CreateProcessW(file, command.data(), nullptr, nullptr, FALSE, CREATE_SUSPENDED | CREATE_NO_WINDOW,
                        nullptr, nullptr, &startup, &process)) throw std::runtime_error("Cannot start job fixture child");
    KernelHandle thread(process.hThread);
    if (!AssignProcessToJobObject(job, process.hProcess)) { TerminateProcess(process.hProcess, 1); CloseHandle(process.hProcess); throw std::runtime_error("Cannot assign fixture child to job"); }
    ResumeThread(thread.value); return process.hProcess;
}

void CheckOwnedJob(bool rootAlreadyExited) {
    KernelHandle job(CreateJobObjectW(nullptr, nullptr));
    if (!job.value) throw std::runtime_error("Cannot create fixture job");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{}; limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) throw std::runtime_error("Cannot configure fixture job");
    KernelHandle root(SleepingChild(job.value)), remaining(SleepingChild(job.value));
    if (rootAlreadyExited) { TerminateProcess(root.value, 0); WaitForSingleObject(root.value, 5000); }
    DrainOwnedJob(job.value, root.value);
    if (WaitForSingleObject(root.value, 0) != WAIT_OBJECT_0 || WaitForSingleObject(remaining.value, 0) != WAIT_OBJECT_0)
        throw std::runtime_error("Single-instance ownership was released while a job process remained alive");
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    if (!QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr) || accounting.ActiveProcesses)
        throw std::runtime_error("The owned job was not empty after shutdown");
}
void CheckCrashHandoff(const fs::path& executable) {
    const auto name = L"handoff-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64());
    const auto names = DesktopSingleInstance::TestNames(name);
    const auto ready = executable.parent_path() / L"crash-job-ready";
    auto command = QuoteArgument(executable.wstring()) + L" --crash-job-owner " + QuoteArgument(name) + L" " + QuoteArgument(ready.wstring());
    STARTUPINFOW startup{}; startup.cb = sizeof(startup); PROCESS_INFORMATION child{};
    if (!CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW,
                        nullptr, nullptr, &startup, &child)) throw std::runtime_error("Cannot start crash handoff owner");
    KernelHandle owner(child.hProcess), thread(child.hThread);
    try {
        DWORD rootId = 0, remainingId = 0;
        const auto started = GetTickCount64();
        while (!remainingId && GetTickCount64() - started < 10000) {
            std::ifstream input(ready); input >> rootId >> remainingId;
            if (!remainingId) Sleep(1);
        }
        KernelHandle root(OpenProcess(SYNCHRONIZE, FALSE, rootId)), remaining(OpenProcess(SYNCHRONIZE, FALSE, remainingId));
        if (!root.value || !remaining.value) throw std::runtime_error("Cannot observe old job processes");
        DesktopSingleInstance::Instance successor(names);
        KernelHandle observer(OpenJobObjectW(JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE, FALSE, successor.JobName().c_str()));
        if (!observer.value) throw std::runtime_error("Cannot observe the old named desktop job");
        TerminateProcess(owner.value, 9); WaitForSingleObject(owner.value, 10000);
        if (!successor.TryAcquire()) throw std::runtime_error("Cannot take over the crashed desktop mutex");
        // Holding an observation handle deliberately postpones KILL_ON_JOB_CLOSE.
        // This makes the crash gap deterministic, including the case where the
        // next desktop has already opened the old job while its owner exits.
        if (WaitForSingleObject(root.value, 0) != WAIT_TIMEOUT || WaitForSingleObject(remaining.value, 0) != WAIT_TIMEOUT)
            throw std::runtime_error("Crash handoff fixture exited before the handoff check");
        DrainPreviousOwnedJob(successor.JobName());
        if (WaitForSingleObject(root.value, 0) != WAIT_OBJECT_0 || WaitForSingleObject(remaining.value, 0) != WAIT_OBJECT_0)
            throw std::runtime_error("Crash handoff allowed profile access before all old processes signaled");
        observer.reset();
        KernelHandle fresh; PrepareOwnedJob(fresh, successor.JobName());
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
        if (!QueryInformationJobObject(fresh.value, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr)
            || accounting.ActiveProcesses) throw std::runtime_error("Successor desktop did not get a fresh empty job");
        fs::remove(ready);
    } catch (...) { TerminateProcess(owner.value, 1); WaitForSingleObject(owner.value, 10000); throw; }
}
void CheckRestrictedJob() {
    const auto names = DesktopSingleInstance::TestNames(L"restricted-job-" + std::to_wstring(GetCurrentProcessId()));
    DesktopSingleInstance::Instance instance(names);
    const auto sid = DesktopSingleInstance::ProcessSid(GetCurrentProcess());
    const auto text = L"D:P(A;;0x00000004;;;" + sid + L")";
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(text.c_str(), SDDL_REVISION_1, &descriptor, nullptr))
        throw std::runtime_error("Cannot create restricted job descriptor");
    std::unique_ptr<void, decltype(&LocalFree)> allocation(descriptor, LocalFree);
    SECURITY_ATTRIBUTES security{sizeof(security), descriptor, FALSE};
    KernelHandle previous(CreateJobObjectW(&security, instance.JobName().c_str()));
    if (!previous.value) throw std::runtime_error("Cannot create restricted job fixture");
    KernelHandle fresh; bool rejected = false;
    try { PrepareOwnedJob(fresh, instance.JobName()); } catch (...) { rejected = true; }
    if (!rejected || fresh.value) throw std::runtime_error("An inaccessible previous job did not fail closed");
}
LRESULT CALLBACK WindowProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
    if (message == RESTORE) { std::cout << "restore" << std::endl; return 0; }
    if (message == WM_TIMER && fs::exists(quitFile)) { DestroyWindow(window); return 0; }
    if (message == WM_CLOSE) { DestroyWindow(window); return 0; }
    if (message == WM_DESTROY) { PostQuitMessage(0); return 0; }
    return DefWindowProcW(window, message, wParam, lParam);
}
}

int wmain(int argc, wchar_t** argv) {
    try {
        if (argc == 2 && std::wstring(argv[1]) == L"--job-sleeper") { Sleep(30000); return 0; }
        if (argc == 4 && std::wstring(argv[1]) == L"--crash-job-owner") {
            DesktopSingleInstance::Instance instance(DesktopSingleInstance::TestNames(argv[2]));
            if (!instance.TryAcquire()) throw std::runtime_error("Cannot own isolated crash handoff mutex");
            KernelHandle job; PrepareOwnedJob(job, instance.JobName());
            KernelHandle root(SleepingChild(job.value)), remaining(SleepingChild(job.value));
            { std::ofstream ready(argv[3]); ready << GetProcessId(root.value) << ' ' << GetProcessId(remaining.value); }
            Sleep(30000); return 0;
        }
        if (argc == 2 && std::wstring(argv[1]) == L"--job-exit-test") {
            CheckOwnedJob(false); CheckOwnedJob(true); CheckCrashHandoff(fs::absolute(argv[0])); CheckRestrictedJob();
            std::cout << "job-empty" << std::endl; return 0;
        }
        if (argc == 2 && std::wstring(argv[1]) == L"--find-production") {
            DesktopSingleInstance::Instance instance;
            DWORD pid = 0;
            if (auto window = instance.Existing(L"Claude Bridge · C++ 桌面版")) GetWindowThreadProcessId(window, &pid);
            std::cout << pid << std::endl; return 0;
        }
        if (argc != 5) throw std::runtime_error("Expected namespace, mode, quit path and startup delay");
        const std::wstring name(argv[1]), mode(argv[2]); quitFile = argv[3];
        auto names = DesktopSingleInstance::TestNames(name);
        names.legacyPrefix = L"ClaudeBridge.Desktop.Test.Legacy." + name + L".";
        const auto title = L"Claude Bridge single-instance fixture " + name;
        if (mode == L"lifecycle") {
            CheckMutexRelease(names); std::cout << "mutex-released" << std::endl; return 0;
        }
        if (mode == L"foreign") {
            if (DesktopSingleInstance::FindExisting(names, L"S-1-0-0", title)) throw std::runtime_error("A foreign user SID was accepted");
            std::cout << "foreign-filtered" << std::endl; return 0;
        }
        if (!DesktopSingleInstance::LegacyClass(names.legacyPrefix + L"65535", names.legacyPrefix)
            || DesktopSingleInstance::LegacyClass(names.legacyPrefix + L"malformed", names.legacyPrefix))
            throw std::runtime_error("Legacy window matching accepted an invalid class");
        std::unique_ptr<DesktopSingleInstance::Instance> instance;
        KernelHandle restricted;
        if (mode.starts_with(L"restricted")) {
            // Reproduce a same-user object that can be observed but cannot be
            // opened for mutation, without elevation or touching a real lock.
            const auto sid = DesktopSingleInstance::ProcessSid(GetCurrentProcess());
            const auto text = L"D:P(A;;0x00100000;;;" + sid + L")";
            PSECURITY_DESCRIPTOR descriptor = nullptr;
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(text.c_str(), SDDL_REVISION_1, &descriptor, nullptr))
                throw std::runtime_error(WindowsError("Create restricted mutex descriptor"));
            std::unique_ptr<void, decltype(&LocalFree)> allocation(descriptor, LocalFree);
            SECURITY_ATTRIBUTES security{sizeof(security), descriptor, FALSE};
            restricted.reset(CreateMutexW(&security, TRUE, (names.mutexPrefix + sid).c_str()));
            if (!restricted.value) throw std::runtime_error(WindowsError("Create restricted mutex fixture"));
            std::cout << "owner" << std::endl;
        } else if (mode != L"legacy") {
            instance = std::make_unique<DesktopSingleInstance::Instance>(names);
            if (!instance->AcquireOrActivate(mode == L"minimized", title, RESTORE, 5000)) { std::cout << "secondary" << std::endl; return 0; }
            std::cout << "owner" << std::endl;
            if (mode == L"probe" || mode == L"minimized") return 0;
        }
        Sleep(static_cast<DWORD>(std::stoul(argv[4])));
        if (mode == L"crash" || mode == L"restricted-crash") TerminateProcess(GetCurrentProcess(), 9);
        if (mode == L"early" || mode == L"restricted-early") return 0;
        auto type = mode == L"legacy" ? names.legacyPrefix + L"6543" : names.windowClass;
        WNDCLASSW cls{}; cls.hInstance = GetModuleHandleW(nullptr); cls.lpfnWndProc = WindowProc; cls.lpszClassName = type.c_str();
        if (!RegisterClassW(&cls)) throw std::runtime_error(WindowsError("Register fixture window"));
        HWND window = CreateWindowW(type.c_str(), title.c_str(), WS_OVERLAPPEDWINDOW, 0, 0, 100, 100, nullptr, nullptr, cls.hInstance, nullptr);
        if (!window) throw std::runtime_error(WindowsError("Create fixture window"));
        // The fake SID check must not recognize even an otherwise matching
        // window. This tests the same filter used for older release discovery.
        if (DesktopSingleInstance::FindExisting(names, L"S-1-0-0", title)) throw std::runtime_error("A foreign user SID was accepted");
        SetTimer(window, 1, 50, nullptr); std::cout << "window" << std::endl;
        MSG message;
        while (GetMessageW(&message, nullptr, 0, 0) > 0) { TranslateMessage(&message); DispatchMessageW(&message); }
        return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << std::endl; return 1; }
}
