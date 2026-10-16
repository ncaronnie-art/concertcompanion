#!/usr/bin/env python3
"""Create a deterministic, dependency-free Xcode project for the native alpha."""
from pathlib import Path
import hashlib
import json
import plistlib

ROOT = Path(__file__).resolve().parents[1]
IOS = ROOT / "iOS"
PROJECT = IOS / "ConcertCompass.xcodeproj"
PROJECT.mkdir(exist_ok=True)
objects = {}

def uid(name):
    return hashlib.sha1(name.encode()).hexdigest()[:24].upper()

def obj(name, body):
    key = uid(name)
    objects[key] = body
    return key

def arr(values):
    return "(" + ", ".join(values) + ("," if values else "") + ")"

def ref(path, kind):
    return obj("file:" + path, f'isa = PBXFileReference; lastKnownFileType = {kind}; path = "{path}"; sourceTree = "<group>";')

def build(name, file_ref):
    return obj("build:" + name, f"isa = PBXBuildFile; fileRef = {file_ref};")

app_files = sorted((IOS / "ConcertCompass").glob("*.swift"))
app_refs = [ref(p.name, "sourcecode.swift") for p in app_files]
app_build = [build("app:" + p.name, r) for p, r in zip(app_files, app_refs)]
test_refs = [ref("NativePipelineTests.swift", "sourcecode.swift")]
test_build = [build("tests", test_refs[0])]
fixture_refs = [ref(p.name, "file") for p in sorted((IOS / "ConcertCompassTests/Fixtures").iterdir()) if p.suffix in (".mp4", ".mov")]
fixture_build = [build("fixture:" + r, r) for r in fixture_refs]
fixture_group = obj("fixtures", f'isa = PBXGroup; children = {arr(fixture_refs)}; path = Fixtures; sourceTree = "<group>";')
privacy = ref("PrivacyInfo.xcprivacy", "text.xml")
info = ref("Info.plist", "text.plist.xml")
assets = ref("Assets.xcassets", "folder.assetcatalog")
app_group = obj("appGroup", f'isa = PBXGroup; children = {arr(app_refs + [info, privacy, assets])}; path = ConcertCompass; sourceTree = "<group>";')
test_group = obj("testGroup", f'isa = PBXGroup; children = {arr(test_refs + [fixture_group])}; path = ConcertCompassTests; sourceTree = "<group>";')
app_product = obj("appProduct", 'isa = PBXFileReference; explicitFileType = wrapper.application; path = ConcertCompass.app; sourceTree = BUILT_PRODUCTS_DIR;')
test_product = obj("testProduct", 'isa = PBXFileReference; explicitFileType = wrapper.cfbundle; path = ConcertCompassTests.xctest; sourceTree = BUILT_PRODUCTS_DIR;')
products = obj("products", f'isa = PBXGroup; children = {arr([app_product, test_product])}; name = Products; sourceTree = "<group>";')
main_group = obj("mainGroup", f'isa = PBXGroup; children = {arr([app_group, test_group, products])}; sourceTree = "<group>";')
local_package = obj("localPackage", 'isa = XCLocalSwiftPackageReference; relativePath = "..";')
core_product = obj("coreProduct", f"isa = XCSwiftPackageProductDependency; package = {local_package}; productName = CompassCore;")
core_app = obj("coreAppBuild", f"isa = PBXBuildFile; productRef = {core_product};")
core_test = obj("coreTestBuild", f"isa = PBXBuildFile; productRef = {core_product};")

def phase(name, kind, files):
    return obj(name, f"isa = {kind}; buildActionMask = 2147483647; files = {arr(files)}; runOnlyForDeploymentPostprocessing = 0;")

app_sources = phase("appSources", "PBXSourcesBuildPhase", app_build)
app_frameworks = phase("appFrameworks", "PBXFrameworksBuildPhase", [core_app])
app_resources = phase("appResources", "PBXResourcesBuildPhase", [build("privacy", privacy), build("assets", assets)])
test_sources = phase("testSources", "PBXSourcesBuildPhase", test_build)
test_frameworks = phase("testFrameworks", "PBXFrameworksBuildPhase", [core_test])
test_resources = phase("testResources", "PBXResourcesBuildPhase", fixture_build)

def config_list(prefix, extra):
    ids = []
    for name in ["Debug", "Release"]:
        optimization = 'SWIFT_OPTIMIZATION_LEVEL = "-Onone"; SWIFT_ACTIVE_COMPILATION_CONDITIONS = "DEBUG $(inherited)"; ENABLE_TESTABILITY = YES;' if name == "Debug" else 'SWIFT_OPTIMIZATION_LEVEL = "-O";'
        common = 'CLANG_ENABLE_MODULES = YES; SWIFT_VERSION = 5.0; IPHONEOS_DEPLOYMENT_TARGET = 17.0; SDKROOT = iphoneos; SWIFT_STRICT_CONCURRENCY = targeted;'
        ids.append(obj(prefix + name, f'isa = XCBuildConfiguration; buildSettings = {{ {common} {optimization} {extra} }}; name = {name};'))
    return obj(prefix + "Configs", f'isa = XCConfigurationList; buildConfigurations = {arr(ids)}; defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;')

project_configs = config_list("project", '')
app_configs = config_list("app", '''PRODUCT_NAME = "$(TARGET_NAME)"; PRODUCT_MODULE_NAME = ConcertCompass;
PRODUCT_BUNDLE_IDENTIFIER = com.ronnie.concertcompass.alpha; GENERATE_INFOPLIST_FILE = NO;
INFOPLIST_FILE = ConcertCompass/Info.plist; ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;
CODE_SIGN_STYLE = Automatic; CURRENT_PROJECT_VERSION = 1; MARKETING_VERSION = 0.1.0;
TARGETED_DEVICE_FAMILY = 1; SUPPORTED_PLATFORMS = "iphoneos iphonesimulator";
LD_RUNPATH_SEARCH_PATHS = "$(inherited) @executable_path/Frameworks";''')
test_configs = config_list("test", '''PRODUCT_NAME = "$(TARGET_NAME)"; PRODUCT_MODULE_NAME = ConcertCompassTests;
PRODUCT_BUNDLE_IDENTIFIER = com.ronnie.concertcompass.alpha.tests; GENERATE_INFOPLIST_FILE = YES;
CODE_SIGN_STYLE = Automatic; TARGETED_DEVICE_FAMILY = 1;
TEST_HOST = "$(BUILT_PRODUCTS_DIR)/ConcertCompass.app/ConcertCompass"; BUNDLE_LOADER = "$(TEST_HOST)";
LD_RUNPATH_SEARCH_PATHS = "$(inherited) @executable_path/Frameworks @loader_path/Frameworks";''')
app_target = uid("appTarget")
test_proxy = obj("testProxy", f'isa = PBXContainerItemProxy; containerPortal = {uid("project")}; proxyType = 1; remoteGlobalIDString = {app_target}; remoteInfo = ConcertCompass;')
test_dependency = obj("testDependency", f"isa = PBXTargetDependency; target = {app_target}; targetProxy = {test_proxy};")
obj("appTarget", f'''isa = PBXNativeTarget; buildConfigurationList = {app_configs}; buildPhases = {arr([app_sources, app_frameworks, app_resources])};
buildRules = (); dependencies = (); name = ConcertCompass; packageProductDependencies = {arr([core_product])}; productName = ConcertCompass;
productReference = {app_product}; productType = "com.apple.product-type.application";''')
test_target = obj("testTarget", f'''isa = PBXNativeTarget; buildConfigurationList = {test_configs}; buildPhases = {arr([test_sources, test_frameworks, test_resources])};
buildRules = (); dependencies = {arr([test_dependency])}; name = ConcertCompassTests; packageProductDependencies = {arr([core_product])}; productName = ConcertCompassTests;
productReference = {test_product}; productType = "com.apple.product-type.bundle.unit-test";''')
root_id = obj("project", f'''isa = PBXProject; attributes = {{ LastUpgradeCheck = 1600; BuildIndependentTargetsInParallel = YES; }};
buildConfigurationList = {project_configs}; compatibilityVersion = "Xcode 14.0"; developmentRegion = en;
hasScannedForEncodings = 0; knownRegions = (en, Base); mainGroup = {main_group}; packageReferences = {arr([local_package])};
productRefGroup = {products}; projectDirPath = ""; projectRoot = ""; targets = {arr([app_target, test_target])};''')
text = '// !$*UTF8*$!\n{ archiveVersion = 1; classes = {}; objectVersion = 56; objects = {\n'
text += '\n'.join(f'{key} = {{ {value} }};' for key, value in objects.items())
text += f'\n}}; rootObject = {root_id}; }}\n'
(PROJECT / "project.pbxproj").write_text(text)
scheme_dir = PROJECT / "xcshareddata/xcschemes"
scheme_dir.mkdir(parents=True, exist_ok=True)

def buildable(target, name):
    product = "ConcertCompass.app" if name == "ConcertCompass" else "ConcertCompassTests.xctest"
    return f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{target}" BuildableName="{product}" BlueprintName="{name}" ReferencedContainer="container:ConcertCompass.xcodeproj"/>'

scheme = f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="1600" version="1.3">
<BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries>
<BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{buildable(app_target, "ConcertCompass")}</BuildActionEntry>
</BuildActionEntries></BuildAction>
<TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES">
<Testables><TestableReference skipped="NO" parallelizable="NO">{buildable(test_target, "ConcertCompassTests")}</TestableReference></Testables>
</TestAction>
<LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" debugServiceExtension="internal" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">{buildable(app_target, "ConcertCompass")}</BuildableProductRunnable></LaunchAction>
<ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0">{buildable(app_target, "ConcertCompass")}</BuildableProductRunnable></ProfileAction>
<AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>'''
(scheme_dir / "ConcertCompass.xcscheme").write_text(scheme)
info = {
    "CFBundleDevelopmentRegion": "$(DEVELOPMENT_LANGUAGE)", "CFBundleDisplayName": "Concert Compass",
    "CFBundleExecutable": "$(EXECUTABLE_NAME)", "CFBundleIdentifier": "$(PRODUCT_BUNDLE_IDENTIFIER)",
    "CFBundleInfoDictionaryVersion": "6.0", "CFBundleName": "$(PRODUCT_NAME)", "CFBundlePackageType": "APPL",
    "CFBundleShortVersionString": "$(MARKETING_VERSION)", "CFBundleVersion": "$(CURRENT_PROJECT_VERSION)",
    "LSRequiresIPhoneOS": True, "UILaunchScreen": {}, "UIUserInterfaceStyle": "Dark",
    "UISupportedInterfaceOrientations": ["UIInterfaceOrientationPortrait"], "ITSAppUsesNonExemptEncryption": False,
    "NSPhotoLibraryAddUsageDescription": "Save the concert reel you have reviewed to your photo library. Originals are never replaced."
}
(IOS / "ConcertCompass/Info.plist").write_bytes(plistlib.dumps(info))
privacy = {"NSPrivacyTracking": False, "NSPrivacyTrackingDomains": [], "NSPrivacyCollectedDataTypes": [], "NSPrivacyAccessedAPITypes": []}
(IOS / "ConcertCompass/PrivacyInfo.xcprivacy").write_bytes(plistlib.dumps(privacy))
print("Generated Xcode project, shared scheme, Info.plist and privacy manifest.")
