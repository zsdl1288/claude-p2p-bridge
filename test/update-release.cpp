#include "../native/desktop/update-release.hpp"
#include <cassert>
#include <iostream>

using namespace DesktopUpdate;
namespace D = DesktopUpdate::ReleaseDetail;

template<class Action> void Rejected(Action&& action) {
    bool rejected = false;
    try { action(); } catch (const std::exception&) { rejected = true; }
    assert(rejected);
}
Json Release(const std::string& version = "1.2.13") {
    const auto name = D::AssetName(version), tag = "v" + version;
    return Json{{"tag_name", tag}, {"draft", false}, {"prerelease", false}, {"html_url", D::HtmlUrl(tag)}, {"assets", Json::array({
        Json{{"name", name}, {"state", "uploaded"}, {"size", 12345}, {"digest", "sha256:" + std::string(64, 'a')},
             {"browser_download_url", D::AssetUrl(tag, name)}}
    })}};
}
void ParseCases() {
    auto source = Release(); const auto result = ParseRelease(source, "1.2.12");
    assert(result["version"] == "1.2.13" && result["name"] == D::AssetName("1.2.13") && result["sha256"] == std::string(64, 'a'));
    assert(ParseRelease(source, "1.2.13").is_null());
    assert(ParseRelease(source, "1.2.99").is_null());
    assert(ParseRelease(Release("1.10.0"), "1.9.99")["version"] == "1.10.0");
    assert(ParseRelease(Release("1.2.4"), "1.2.12").is_null());
    source["draft"] = true; assert(ParseRelease(source, "1.0.0").is_null()); source["draft"] = false;
    source["prerelease"] = true; assert(ParseRelease(source, "1.0.0").is_null()); source["prerelease"] = false;
    for (const auto& tag : {"v1.2.14-beta", "v1.2.014", "v1.2.14+build", "v65536.0.0", "1.2", "v-1.2.13", "v1.2.13/other"}) {
        source["tag_name"] = tag; assert(ParseRelease(source, "1.0.0").is_null());
    }
    Rejected([&] { ParseRelease(Release(), "v1.2.12"); });
    source = Release(); source["assets"].push_back(source["assets"][0]); Rejected([&] { ParseRelease(source, "1.0.0"); });
    source = Release(); source["assets"][0]["name"] = "ClaudeBridge-1.2.13-local-diagnostics-windows-x64.exe";
    Rejected([&] { ParseRelease(source, "1.0.0"); });
    source = Release(); source["assets"][0]["name"] = "ClaudeBridge-1.2.13-windows-arm64.exe";
    Rejected([&] { ParseRelease(source, "1.0.0"); });
    for (const Json& size : {Json(0), Json(-1), Json(1.5), Json("12345"), Json(MaximumExecutableBytes + 1)}) {
        source = Release(); source["assets"][0]["size"] = size; Rejected([&] { ParseRelease(source, "1.0.0"); });
    }
    for (const auto* key : {"html_url", "draft", "prerelease", "assets"}) {
        source = Release(); source.erase(key); Rejected([&] { ParseRelease(source, "1.0.0"); });
    }
    source = Release(); source["html_url"] = "https://github.com/other/repo/releases/tag/v1.2.13";
    Rejected([&] { ParseRelease(source, "1.0.0"); });
    for (const auto& url : {"https://evil.test/ClaudeBridge-1.2.13-windows-x64.exe", "http://github.com/zsdl1288/claude-p2p-bridge/releases/download/v1.2.13/ClaudeBridge-1.2.13-windows-x64.exe"}) {
        source = Release(); source["assets"][0]["browser_download_url"] = url; Rejected([&] { ParseRelease(source, "1.0.0"); });
    }
    source = Release(); source["assets"][0]["state"] = "new"; Rejected([&] { ParseRelease(source, "1.0.0"); });
    source = Release(); source["assets"][0]["digest"] = "sha256:" + std::string(64, 'F'); assert(ParseRelease(source, "1.0.0")["sha256"] == std::string(64, 'f'));
    for (const Json& digest : {Json("md5:" + std::string(64, 'a')), Json("sha256:" + std::string(64, 'g')), Json(13)}) {
        source["assets"][0]["digest"] = digest; Rejected([&] { ParseRelease(source, "1.0.0"); });
    }
    source["assets"][0].erase("digest"); assert(ParseRelease(source, "1.0.0")["sha256"] == "");
    source = Release(); source["tag_name"] = "1.2.13"; source["html_url"] = D::HtmlUrl("1.2.13");
    source["assets"][0]["browser_download_url"] = D::AssetUrl("1.2.13", D::AssetName("1.2.13"));
    assert(ParseRelease(source, "1.0.0")["tag"] == "1.2.13");
}
void CheckCases() {
    std::atomic<bool> cancel = false; auto source = Release(); int calls = 0;
    auto reader = [&](const std::string& url, bool api, uint64_t maximum, uint64_t expected, D::Budget& budget) {
        ++calls; budget.Check(); assert(url == LatestReleaseUrl && api && maximum == MaximumApiBytes && expected == 0); return source.dump();
    };
    assert(D::Check("1.2.12", cancel, reader)["version"] == "1.2.13" && calls == 1);
    assert(D::Check("1.2.13", cancel, reader).is_null());
    cancel = true; const auto previous = calls; Rejected([&] { D::Check("1.2.12", cancel, reader); }); assert(calls == previous); cancel = false;
    const std::string checksum = std::string(64, 'b') + "  " + D::AssetName("1.2.13") + "\n";
    const std::string checksumName = "ClaudeBridge-1.2.13-windows-x64.sha256.txt";
    source["assets"][0].erase("digest");
    source["assets"].push_back(Json{{"name", checksumName}, {"state", "uploaded"}, {"size", checksum.size()},
        {"digest", "sha256:" + Sha256(reinterpret_cast<const unsigned char*>(checksum.data()), checksum.size())},
        {"browser_download_url", D::AssetUrl("v1.2.13", checksumName)}});
    auto fallback = [&](const std::string& url, bool api, uint64_t maximum, uint64_t expected, D::Budget&) {
        if (api) { assert(url == LatestReleaseUrl); return source.dump(); }
        assert(url == D::AssetUrl("v1.2.13", checksumName) && maximum == MaximumChecksumBytes && expected == checksum.size()); return checksum;
    };
    assert(D::Check("1.2.12", cancel, fallback)["sha256"] == std::string(64, 'b'));
    source["assets"][1]["digest"] = "sha256:" + std::string(64, '0'); Rejected([&] { D::Check("1.2.12", cancel, fallback); });
    source["assets"].erase(1); Rejected([&] { D::Check("1.2.12", cancel, fallback); });
    assert(D::ParseChecksum(std::string(64, 'F') + " *" + D::AssetName("1.2.13") + "\r\n", D::AssetName("1.2.13")) == std::string(64, 'f'));
    for (const auto& content : {checksum + "\n", std::string(64, 'b'), std::string(64, 'b') + "  ../" + D::AssetName("1.2.13"), std::string(64, 'b') + "  " + D::AssetName("1.2.14")})
        Rejected([&] { D::ParseChecksum(content, D::AssetName("1.2.13")); });
}
void UrlCases() {
    assert(D::ParseUrl(LatestReleaseUrl, true).host == L"api.github.com");
    assert(D::ParseUrl(D::AssetUrl("v1.2.13", D::AssetName("1.2.13"))).host == L"github.com");
    assert(D::ParseUrl("https://release-assets.githubusercontent.com/github-production-release-asset/a?sp=r&sig=123").host == L"release-assets.githubusercontent.com");
    assert(D::ParseUrl("https://objects.githubusercontent.com/github-production-release-asset/a").host == L"objects.githubusercontent.com");
    for (const auto& url : {"http://release-assets.githubusercontent.com/a", "https://release-assets.githubusercontent.com.evil.test/a",
         "https://@release-assets.githubusercontent.com/a",
         "https://user:secret@release-assets.githubusercontent.com/a", "https://github.com/other/repo/a", "https://evil.test/a",
         "https://github.com:444/zsdl1288/claude-p2p-bridge/releases/download/x", "//release-assets.githubusercontent.com/a",
         "https://release-assets.githubusercontent.com/a#fragment", "https://release-assets.githubusercontent.com/a\r\nX: secret",
         "https://release-assets.githubusercontent.com\\evil.test/a", "https://api.github.com/repos/other/repo/releases/latest"})
        Rejected([&] { D::ParseUrl(url); });
    Rejected([&] { D::ParseUrl("https://api.github.com/repos/other/repo/releases/latest", true); });
    assert(D::ContentLength("12345", 12345) == 12345);
    for (const auto& length : {"12346", "-1", "1.5", "999999999999999999999", "1\r\n"}) Rejected([&] { D::ContentLength(length, 12345); });
}
void DownloadCases(const fs::path& executable) {
    const auto directory = fs::temp_directory_path() / (L"ClaudeBridge-update-unit-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64()));
    fs::create_directory(directory);
    struct Cleanup { fs::path path; ~Cleanup() { std::error_code error; fs::remove_all(path, error); } } cleanup{directory};
    const auto hash = FileHash(executable); VerifyExecutable(executable, hash, "1.2.13");
    Rejected([&] { VerifyExecutable(executable, hash, "1.2.14"); });
    Rejected([&] { VerifyExecutable(executable, std::string(64, '0'), "1.2.13"); });
    std::ifstream file(executable, std::ios::binary); std::string content((std::istreambuf_iterator<char>(file)), {});
    auto release = ParseRelease(Release(), "1.2.12"); release["size"] = content.size(); release["sha256"] = hash;
    std::atomic<bool> cancel = false; uint64_t lastProgress = 0;
    auto fetch = [&](const std::string& url, uint64_t size, D::Budget& budget, const D::Sink& sink) {
        assert(url == release["url"].get<std::string>() && size == content.size()); budget.Check();
        for (size_t offset = 0; offset < content.size(); offset += 65536) sink(content.data() + offset, std::min<size_t>(65536, content.size() - offset));
    };
    auto progress = [&](uint64_t downloaded, uint64_t total) { assert(total == content.size() && downloaded >= lastProgress && downloaded <= total); lastProgress = downloaded; };
    const auto target = D::Download(release, directory, cancel, progress, fetch);
    assert(target == directory / L"new.exe" && lastProgress == content.size() && FileHash(target) == hash && !fs::exists(directory / L"new.exe.part"));
    Rejected([&] { D::Download(release, directory, cancel, {}, fetch); }); assert(FileHash(target) == hash); fs::remove(target);
    auto noFiles = [&] { assert(!fs::exists(directory / L"new.exe") && !fs::exists(directory / L"new.exe.part")); };
    auto failed = [&](const auto& candidate, auto&& reader) { Rejected([&] { D::Download(candidate, directory, cancel, {}, reader); }); noFiles(); };
    auto bad = release; bad["sha256"] = std::string(64, '0'); failed(bad, fetch);
    bad = release; bad["sha256"] = ""; failed(bad, fetch);
    bad = release; bad["url"] = "https://evil.test/a"; failed(bad, fetch);
    bad = release; bad["size"] = 1;
    failed(bad, [&](const std::string&, uint64_t, D::Budget&, const D::Sink& sink) { sink(content.data(), content.size()); });
    failed(release, [&](const std::string&, uint64_t, D::Budget&, const D::Sink& sink) { sink(content.data(), 2); });
    failed(release, [&](const std::string&, uint64_t, D::Budget&, const D::Sink& sink) { sink(content.data(), 2); throw std::runtime_error("simulated disconnect"); });
    failed(release, [&](const std::string&, uint64_t, D::Budget&, const D::Sink& sink) { sink(content.data(), 2); cancel = true; sink(content.data() + 2, 2); }); cancel = false;
    cancel = true; failed(release, fetch); cancel = false;
    Rejected([&] { D::Download(release, directory, cancel, [](uint64_t, uint64_t) { throw std::runtime_error("progress cancelled"); }, fetch); }); noFiles();
    const auto text = directory / L"invalid.exe"; { std::ofstream output(text, std::ios::binary); output << "abc"; }
    assert(FileHash(text) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    Rejected([&] { VerifyExecutable(text, FileHash(text), "1.2.13"); });
    const auto wrongArchitecture = directory / L"wrong-machine.exe"; fs::copy_file(executable, wrongArchitecture);
    { std::fstream modify(wrongArchitecture, std::ios::in | std::ios::out | std::ios::binary); IMAGE_DOS_HEADER dos{}; modify.read(reinterpret_cast<char*>(&dos), sizeof(dos));
      const WORD machine = IMAGE_FILE_MACHINE_I386; modify.seekp(dos.e_lfanew + sizeof(DWORD)); modify.write(reinterpret_cast<const char*>(&machine), sizeof(machine)); }
    Rejected([&] { VerifyExecutable(wrongArchitecture, FileHash(wrongArchitecture), "1.2.13"); });
    // A caller-held read lock must remain compatible with the helper's second
    // verification, while no writer or renamer can change the candidate.
    const auto lockedCopy = directory / L"locked-copy.exe"; fs::copy_file(executable, lockedCopy);
    KernelHandle locked(VerifyDetail::OpenLocked(lockedCopy)); VerifyExecutable(lockedCopy, hash, "1.2.13");
    KernelHandle writer(CreateFileW(lockedCopy.c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, 0, nullptr));
    assert(writer.value == INVALID_HANDLE_VALUE);
    assert(!DeleteFileW(lockedCopy.c_str()));
    locked.reset(); assert(DeleteFileW(lockedCopy.c_str()));
}
int main(int argc, char** argv) {
    try {
        if (argc == 3 && std::string(argv[1]) == "--live-download") {
            const std::atomic<bool> cancel = false; const auto release = CheckRelease(argv[2], cancel);
            if (release.is_null()) { std::cout << "null\n"; return 0; }
            const auto directory = fs::temp_directory_path() / (L"ClaudeBridge-update-download-unit-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64()));
            fs::create_directory(directory);
            struct Cleanup { fs::path path; ~Cleanup() { std::error_code error; fs::remove_all(path, error); } } cleanup{directory};
            ULONGLONG last = 0;
            const auto file = DownloadRelease(release, directory, cancel, [&](uint64_t received, uint64_t total) {
                const auto now = GetTickCount64();
                if (received != total && last && now - last < 5000) return;
                last = now; std::cout << "Downloaded " << received << '/' << total << " bytes\n" << std::flush;
            });
            std::cout << "Verified " << release["version"].get<std::string>() << " SHA256 " << FileHash(file) << '\n';
            fs::remove_all(directory); assert(!fs::exists(directory));
            std::cout << "Isolated download removed; candidate was not executed or installed\n";
            return 0;
        }
        if ((argc == 2 || argc == 3) && std::string(argv[1]) == "--live-check") {
            const std::atomic<bool> cancel = false; const auto release = CheckRelease(argc == 3 ? argv[2] : "1.2.12", cancel);
            std::cout << release.dump() << '\n'; return 0;
        }
        ParseCases(); CheckCases(); UrlCases();
        wchar_t executable[32768]; const auto length = GetModuleFileNameW(nullptr, executable, 32768);
        assert(length && length < 32768); DownloadCases(fs::path(std::wstring(executable, length)));
        std::cout << "Update release selection, trust boundaries, checksum fallback, executable verification and download cleanup passed\n";
        return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
