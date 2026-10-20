#pragma once
#include "platform.hpp"

// Terminating a job is asynchronous. A desktop must retain both its job handle
// and its single-instance lock until the root process and all members are gone.
inline void DrainOwnedJob(HANDLE job, HANDLE process) {
    std::vector<std::unique_ptr<KernelHandle>> members;
    std::vector<ULONG_PTR> observed;
    const auto captureMembers = [&] {
        if (!job) return;
        size_t count = 16;
        for (;;) {
            std::vector<unsigned char> buffer(sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) + count * sizeof(ULONG_PTR));
            auto list = reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(buffer.data());
            if (!QueryInformationJobObject(job, JobObjectBasicProcessIdList, list, static_cast<DWORD>(buffer.size()), nullptr)) {
                if (GetLastError() == ERROR_MORE_DATA) { count = std::max(count * 2, static_cast<size_t>(list->NumberOfAssignedProcesses) + 16); continue; }
                return;
            }
            for (DWORD i = 0; i < list->NumberOfProcessIdsInList; ++i) {
                auto pid = list->ProcessIdList[i];
                if (std::find(observed.begin(), observed.end(), pid) != observed.end()) continue;
                auto handle = std::make_unique<KernelHandle>(OpenProcess(SYNCHRONIZE, FALSE, static_cast<DWORD>(pid)));
                if (handle->value) { observed.push_back(pid); members.push_back(std::move(handle)); }
            }
            return;
        }
    };
    captureMembers();
    if (job) TerminateJobObject(job, 0);
    auto lastAttempt = GetTickCount64();
    if (job) for (;;) {
        captureMembers();
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
        if (QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr)
            && accounting.ActiveProcesses == 0) break;
        if (GetTickCount64() - lastAttempt >= 5000) {
            // A slow process/driver must not unlock the user identity while an
            // old engine is alive. Retry termination while retaining ownership.
            TerminateJobObject(job, 0); lastAttempt = GetTickCount64();
        }
        Sleep(25);
    }
    if (process) WaitForSingleObject(process, INFINITE);
    // ActiveProcesses can reach zero slightly before every process object's
    // final signal. Retain handles captured before termination to close this gap.
    for (const auto& member : members) WaitForSingleObject(member->value, INFINITE);
}

inline void DrainPreviousOwnedJob(const std::wstring& name) {
    KernelHandle previous(OpenJobObjectW(JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE, FALSE, name.c_str()));
    if (!previous.value) {
        if (GetLastError() == ERROR_FILE_NOT_FOUND) return;
        throw std::runtime_error(WindowsError("读取前任客户端后台进程作业"));
    }
    // Opening this handle can defer KILL_ON_JOB_CLOSE after a crashed desktop
    // exits. Explicitly terminate and drain instead of waiting for that effect.
    DrainOwnedJob(previous.value, nullptr);
}

inline void PrepareOwnedJob(KernelHandle& destination, const std::wstring& name) {
    const auto started = GetTickCount64();
    for (;;) {
        DrainPreviousOwnedJob(name);
        KernelHandle fresh(CreateJobObjectW(nullptr, name.c_str()));
        const auto result = GetLastError();
        if (!fresh.value) throw std::runtime_error(WindowsError("创建进程作业"));
        if (result == ERROR_ALREADY_EXISTS) {
            // The old object's final process references or an observer handle
            // may still keep its name alive. Never attach a new engine to it.
            fresh.reset();
            if (GetTickCount64() - started >= 5000) throw std::runtime_error("前任客户端后台进程作业尚未释放，请稍后重试");
            Sleep(25); continue;
        }
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(fresh.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)))
            throw std::runtime_error(WindowsError("配置后台进程"));
        destination.reset(fresh.value); fresh.value = nullptr; return;
    }
}
