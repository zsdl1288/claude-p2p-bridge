#include "../native/desktop/lifecycle.hpp"
#include <exception>
#include <iostream>

// This fixture only opens the disposable profile passed by the Python runner.
// Crash modes run in separate processes so they exercise the installed hooks.
int wmain(int argc, wchar_t** argv) {
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    if (argc < 3) return 64;
    const std::wstring mode = argv[1];
    const fs::path directory = argv[2];
    const size_t limit = argc > 3 ? static_cast<size_t>(std::stoull(argv[3])) : 512 * 1024;
    HANDLE locked = INVALID_HANDLE_VALUE;
    if (mode == L"locked") {
        const auto file = directory / L"diagnostics" / L"lifecycle" / L"desktop.jsonl";
        locked = CreateFileW(file.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
                             FILE_ATTRIBUTE_NORMAL, nullptr);
        if (locked == INVALID_HANDLE_VALUE) return 65;
    }
    DesktopLifecycle::Journal journal(limit);
    const bool started = journal.Start(directory, "fixture-1.0.0");
    if (journal.Started() != started) return 66;
    std::cout << Json({{"started", started}, {"sessionId", journal.SessionId()},
                       {"pid", GetCurrentProcessId()}}).dump() << std::endl;
    if (mode == L"probe" || mode == L"locked") {
        // A failed logger must remain harmless to its host application.
        journal.Event("fixture-event", Json({{"token", "fixture-secret-must-not-be-logged"}}));
        journal.Finish("fixture-exit", 0);
        if (locked != INVALID_HANDLE_VALUE) CloseHandle(locked);
        return 0;
    }
    if (!started) return 67;
    if (mode == L"linger") { Sleep(INFINITE); return 68; }
    if (mode == L"seh") {
        RaiseException(0xE0424242UL, EXCEPTION_NONCONTINUABLE, 0, nullptr);
        return 69;
    }
    if (mode == L"terminate") std::terminate();
    const Json privateDetails = {{"token", "fixture-secret-must-not-be-logged"},
        {"message", "fixture-secret-must-not-be-logged"},
        {"error", "fixture-secret-must-not-be-logged"},
        {"argv", "fixture-secret-must-not-be-logged"},
        {"arbitrary", {{"token", "fixture-secret-must-not-be-logged"}}}};
    journal.Event("fixture-event", privateDetails);
    if (mode == L"rotate")
        for (int i = 0; i < 200; ++i) journal.Event("fixture-event", Json({{"exitCode", i}}));
    journal.Finish("user-exit", 0);
    // Repeated completion must not duplicate a terminal record.
    journal.Finish("user-exit", 0);
    return 0;
}
