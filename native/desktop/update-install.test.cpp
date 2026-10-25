#include "update-install.hpp"
#include <iostream>

using namespace DesktopUpdate;
using namespace DesktopUpdate::InstallDetail;

static void Require(bool condition,const char* message) { if(!condition)throw std::runtime_error(message); }
static void Record(const fs::path& directory,const wchar_t* name,Json value) {
    WriteNew(directory/name,value.dump());
}
static std::vector<std::wstring> Arguments(int argc,wchar_t** argv) {
    return {argv+1,argv+argc};
}
static void Unit(const fs::path& directory) {
    fs::create_directories(directory);
    auto stage=CreateStaging(directory);WriteNew(stage/L"extra.txt","fixture");CleanupStaging(stage);Require(!Exists(stage),"owned staging cleanup");
    auto foreign=directory/L"foreign";fs::create_directory(foreign);WriteNew(foreign/L"keep.txt","keep");
    bool rejected=false;try{CleanupStaging(foreign);}catch(...){rejected=true;}
    Require(rejected&&Exists(foreign/L"keep.txt"),"foreign staging retained");
    auto nested=CreateStaging(directory);fs::create_directory(nested/L"nested");
    rejected=false;try{CleanupStaging(nested);}catch(...){rejected=true;}
    Require(rejected&&Exists(nested/L".bridge-update-owner"),"nested staging retained");
    fs::remove(nested/L"nested");CleanupStaging(nested);
    Require(ValidReadyEvent(std::wstring(ReadyEventPrefix)+std::wstring(64,L'a')),"valid event");
    Require(!ValidReadyEvent(std::wstring(ReadyEventPrefix)+std::wstring(64,L'A')),"uppercase event rejected");
    auto target=directory/L"target.bin",backup=directory/L"backup.bin",replacement=directory/L"replacement.bin";
    WriteNew(target,"old");WriteNew(replacement,"new");const auto oldHash=FileHash(target),newHash=FileHash(replacement);
    Require(MoveFileW(target.c_str(),backup.c_str()),"simulate 1177");
    Restore({},target,backup,oldHash,newHash);Require(FileHash(target)==oldHash,"1177 restores missing target");
    Require(MoveFileW(target.c_str(),backup.c_str()),"stage original backup");WriteNew(target,"unrelated");
    rejected=false;try{Restore({},target,backup,oldHash,newHash);}catch(...){rejected=true;}
    Require(rejected&&FileHash(backup)==oldHash&&ReadSmall(target)=="unrelated","foreign target and backup preserved");
    std::cout<<"update installer isolated units passed\n";
}

int wmain(int argc,wchar_t** argv) {
    auto args=Arguments(argc,argv);
    try {
        InstallRuntime runtime;runtime.quiet=true;runtime.parentExitMs=5000;runtime.applicationReadyMs=1200;
        if(!args.empty()&&args[0]==L"--update-install") {
            const auto manifest=Json::parse(ReadSmall(args.at(1)));
            const auto original=manifest.at("arguments");const fs::path directory=Wide(original.at(1).get<std::string>());
            const auto behavior=original.at(2).get<std::string>();
            Record(directory,L"helper.json",{{"pid",GetCurrentProcessId()},{"created",Created(GetCurrentProcess())},{"image",Utf8(Executable().wstring())}});
            if(behavior=="replace1177")runtime.replace=[](LPCWSTR target,LPCWSTR replacement,LPCWSTR backup,DWORD flags)->BOOL {
                if(backup){if(!MoveFileW(target,backup))return FALSE;SetLastError(ERROR_UNABLE_TO_MOVE_REPLACEMENT_2);return FALSE;}
                return ReplaceFileW(target,replacement,backup,flags,nullptr,nullptr);
            };
            if(behavior=="launch-fail")runtime.beforeLaunch=[]{throw std::runtime_error("injected launch failure");};
            const auto result=HandleInstall(args,runtime);
            Record(directory,L"helper-exit.json",{{"code",*result}});return *result;
        }
        if(args.size()==2&&args[0]==L"--unit"){Unit(args[1]);return 0;}
        if(args.size()==2&&args[0]==L"--fixture-descendant") {
            Record(args[1],L"descendant.json",{{"pid",GetCurrentProcessId()},{"created",Created(GetCurrentProcess())},{"image",Utf8(Executable().wstring())}});
            Sleep(15000);return 0;
        }
        if(args.size()>=4&&args[0]==L"--fixture-child") {
            const fs::path directory=args[1];const auto behavior=args[2];const auto newHash=Utf8(args[3]);
            DesktopSingleInstance::Instance instance(runtime.names);Require(instance.TryAcquire(),"fixture child singleton");
            const bool isNew=FileHash(Executable())==newHash;Json recorded=Json::array();for(auto& argument:args)recorded.push_back(Utf8(argument));
            Record(directory,isNew?L"new-started.json":L"rollback-started.json",{{"pid",GetCurrentProcessId()},{"args",recorded},{"hash",FileHash(Executable())}});
            if(!isNew){Sleep(150);return 0;}
            if(behavior==L"exit-early")return 7;
            if(behavior==L"timeout") {
                auto command=Command(Executable(),{L"--fixture-descendant",directory.wstring()});STARTUPINFOW startup{};startup.cb=sizeof(startup);PROCESS_INFORMATION process{};
                Require(CreateProcessW(Executable().c_str(),command.data(),nullptr,nullptr,FALSE,CREATE_NO_WINDOW,nullptr,nullptr,&startup,&process),"fixture descendant");
                CloseHandle(process.hThread);CloseHandle(process.hProcess);Sleep(15000);return 0;
            }
            auto event=std::find(args.begin(),args.end(),L"--update-ready-event");Require(event!=args.end()&&std::next(event)!=args.end(),"new ready event argument");
            SignalUpdateReady(*std::next(event));Record(directory,L"committed.json",{{"ready",true}});
            Sleep(1500);return 0;
        }
        if(args.size()==4&&args[0]==L"--fixture-parent") {
            const fs::path directory=args[1],source=args[2];const auto behavior=args[3];
            DesktopSingleInstance::Instance instance(runtime.names);Require(instance.TryAcquire(),"fixture parent singleton");
            fs::create_directory(directory/L"stages");const auto stage=CreateStaging(directory/L"stages");
            const auto candidate=stage/L"candidate.exe";Require(CopyFileW(source.c_str(),candidate.c_str(),TRUE),"copy candidate");
            const auto hash=FileHash(candidate),oldHash=FileHash(Executable());
            InstallRequest request{stage,Executable(),candidate,hash,"1.0.1",{L"--fixture-child",directory.wstring(),behavior,Wide(hash),L"--data-dir",(directory/L"data with spaces").wstring(),L"--port",L"3217",L"--literal",L"quote\" slash\\ tail\\"}};
            const bool negative=behavior==L"wrong-hash"||behavior==L"wrong-version"||behavior==L"wrong-target"||behavior==L"locked"||behavior==L"readonly"||behavior==L"cancelled";
            if(behavior==L"wrong-hash")request.sha256=std::string(64,'0');
            if(behavior==L"wrong-version")request.version="2.0.0";
            if(behavior==L"wrong-target")request.target=candidate;
            if(behavior==L"readonly")Require(SetFileAttributesW(request.target.c_str(),FILE_ATTRIBUTE_READONLY),"readonly target");
            KernelHandle locked;if(behavior==L"locked")locked.reset(VerifyDetail::OpenLocked(request.target));
            std::atomic<bool> cancelled{behavior==L"cancelled"};
            try { LaunchInstall(request,&cancelled,5000);Require(!negative,"negative preparation was accepted"); }
            catch(const std::exception& error) {
                locked.reset();SetFileAttributesW(Executable().c_str(),FILE_ATTRIBUTE_NORMAL);
                Require(negative,"unexpected preparation failure");Require(FileHash(Executable())==oldHash,"preparation changed target");
                CleanupStaging(stage);Record(directory,L"rejected.json",{{"error",error.what()}});return 0;
            }
            Require(FileHash(Executable())==oldHash,"target changed while parent alive");
            Record(directory,L"parent-ready.json",{{"stage",Utf8(stage.wstring())},{"oldHash",oldHash},{"newHash",hash}});
            Sleep(200);Require(FileHash(Executable())==oldHash,"target replaced before actual parent exit");return 0;
        }
        throw std::runtime_error("unknown fixture invocation");
    } catch(const std::exception& error) {std::cerr<<error.what()<<"\n";return 90;}
}
