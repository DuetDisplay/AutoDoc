#import <AppKit/AppKit.h>
#import <CoreAudio/CoreAudio.h>
#include <libproc.h>

#include <iostream>
#include <set>
#include <string>
#include <vector>

namespace {

std::string toUtf8(NSString *value)
{
  if (value == nil || value.length == 0) return {};
  return std::string([value UTF8String]);
}

std::string jsonEscape(const std::string &value)
{
  std::string result;
  result.reserve(value.size() + 8);

  for (const char ch : value) {
    switch (ch) {
      case '\\': result += "\\\\"; break;
      case '"': result += "\\\""; break;
      case '\b': result += "\\b"; break;
      case '\f': result += "\\f"; break;
      case '\n': result += "\\n"; break;
      case '\r': result += "\\r"; break;
      case '\t': result += "\\t"; break;
      default: result += ch; break;
    }
  }

  return result;
}

std::string bundleIdentifierForAppPath(NSString *appPath)
{
  if (appPath == nil || appPath.length == 0) return {};

  NSBundle *bundle = [NSBundle bundleWithPath:appPath];
  return toUtf8(bundle.bundleIdentifier);
}

std::vector<std::string> identifiersForExecutablePath(NSString *path)
{
  std::set<std::string> result;
  if (path == nil || path.length == 0) return {};

  result.insert(toUtf8(path));
  result.insert(toUtf8(path.lastPathComponent));

  NSRange searchRange = NSMakeRange(0, path.length);
  while (searchRange.location != NSNotFound && searchRange.location < path.length) {
    NSRange appRange = [path rangeOfString:@".app/" options:0 range:searchRange];
    if (appRange.location == NSNotFound) break;

    NSString *appPath = [path substringToIndex:appRange.location + 4];
    const std::string bundleId = bundleIdentifierForAppPath(appPath);
    if (!bundleId.empty()) {
      result.insert(bundleId);
    }

    NSString *appName = appPath.lastPathComponent.stringByDeletingPathExtension;
    const std::string utf8AppName = toUtf8(appName);
    if (!utf8AppName.empty()) {
      result.insert(utf8AppName);
    }

    searchRange.location = appRange.location + 5;
    searchRange.length = path.length - searchRange.location;
  }

  return { result.begin(), result.end() };
}

std::vector<std::string> identifiersForPid(pid_t pid)
{
  std::set<std::string> result;

  NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
  if (app != nil) {
    const std::string bundleId = toUtf8(app.bundleIdentifier);
    if (!bundleId.empty()) {
      result.insert(bundleId);
    }

    if (app.executableURL != nil && app.executableURL.path.length > 0) {
      const std::vector<std::string> executableIds = identifiersForExecutablePath(app.executableURL.path);
      result.insert(executableIds.begin(), executableIds.end());
    }
  }

  char pathBuffer[PROC_PIDPATHINFO_MAXSIZE];
  const int pathLength = proc_pidpath(pid, pathBuffer, sizeof(pathBuffer));
  if (pathLength > 0) {
    NSString *path = [[NSString alloc] initWithBytes:pathBuffer length:pathLength encoding:NSUTF8StringEncoding];
    const std::vector<std::string> executableIds = identifiersForExecutablePath(path);
    result.insert(executableIds.begin(), executableIds.end());
  }

  return { result.begin(), result.end() };
}

std::vector<std::string> getActiveCaptureProcessIds()
{
  std::set<std::string> result;

#if defined(__MAC_14_0) && __MAC_OS_X_VERSION_MAX_ALLOWED >= __MAC_14_0
  if (@available(macOS 14, *)) {
    AudioObjectPropertyAddress processListAddress = {
      kAudioHardwarePropertyProcessObjectList,
      kAudioObjectPropertyScopeGlobal,
      kAudioObjectPropertyElementMain,
    };

    UInt32 dataSize = 0;
    if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &processListAddress, 0, nullptr, &dataSize) != noErr) {
      return {};
    }

    const int count = static_cast<int>(dataSize / sizeof(AudioObjectID));
    std::vector<AudioObjectID> processObjects(count);
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &processListAddress, 0, nullptr, &dataSize, processObjects.data()) != noErr) {
      return {};
    }

    for (const AudioObjectID processObject : processObjects) {
      AudioObjectPropertyAddress runningInputAddress = {
        kAudioProcessPropertyIsRunningInput,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain,
      };

      UInt32 isRunningInput = 0;
      UInt32 runningInputSize = sizeof(isRunningInput);
      if (AudioObjectGetPropertyData(processObject, &runningInputAddress, 0, nullptr, &runningInputSize, &isRunningInput) != noErr || isRunningInput == 0) {
        continue;
      }

      AudioObjectPropertyAddress pidAddress = {
        kAudioProcessPropertyPID,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain,
      };

      pid_t pid = 0;
      UInt32 pidSize = sizeof(pid);
      if (AudioObjectGetPropertyData(processObject, &pidAddress, 0, nullptr, &pidSize, &pid) != noErr || pid <= 0) {
        continue;
      }

      const std::vector<std::string> identifiers = identifiersForPid(pid);
      result.insert(identifiers.begin(), identifiers.end());
    }
  }
#endif

  return { result.begin(), result.end() };
}

} // namespace

int main()
{
  const std::vector<std::string> ids = getActiveCaptureProcessIds();

  std::cout << '[';
  for (size_t index = 0; index < ids.size(); ++index) {
    if (index > 0) std::cout << ',';
    std::cout << '"' << jsonEscape(ids[index]) << '"';
  }
  std::cout << ']';

  return 0;
}
