#include <windows.h>
#include <mmdeviceapi.h>
#include <audiopolicy.h>

#include <iostream>
#include <set>
#include <string>
#include <vector>

namespace {

std::wstring baseNameFromPath(const std::wstring& path)
{
  const size_t slashIndex = path.find_last_of(L"\\/");
  return slashIndex == std::wstring::npos ? path : path.substr(slashIndex + 1);
}

std::string wideToUtf8(const std::wstring& value)
{
  if (value.empty()) return {};

  const int size = WideCharToMultiByte(
    CP_UTF8,
    0,
    value.c_str(),
    static_cast<int>(value.size()),
    nullptr,
    0,
    nullptr,
    nullptr
  );

  if (size <= 0) return {};

  std::string result(size, '\0');
  WideCharToMultiByte(
    CP_UTF8,
    0,
    value.c_str(),
    static_cast<int>(value.size()),
    result.data(),
    size,
    nullptr,
    nullptr
  );
  return result;
}

std::string jsonEscape(const std::string& value)
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
      default:
        result += ch;
        break;
    }
  }

  return result;
}

struct ComInit {
  HRESULT hr;

  ComInit() : hr(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED)) {}

  ~ComInit()
  {
    if (hr == S_OK) {
      CoUninitialize();
    }
  }

  bool ok() const
  {
    return hr == S_OK || hr == S_FALSE || hr == RPC_E_CHANGED_MODE;
  }
};

template <typename T>
struct ComPtr {
  T* ptr = nullptr;

  ~ComPtr()
  {
    if (ptr != nullptr) {
      ptr->Release();
    }
  }

  T** operator&() { return &ptr; }
  T* operator->() const { return ptr; }
  explicit operator bool() const { return ptr != nullptr; }
};

std::vector<std::string> getActiveCaptureProcessIds()
{
  std::set<std::string> result;

  ComInit comInit;
  if (!comInit.ok()) return {};

  ComPtr<IMMDeviceEnumerator> enumerator;
  if (FAILED(CoCreateInstance(
        __uuidof(MMDeviceEnumerator),
        nullptr,
        CLSCTX_ALL,
        __uuidof(IMMDeviceEnumerator),
        reinterpret_cast<void**>(&enumerator)))) {
    return {};
  }

  ComPtr<IMMDeviceCollection> collection;
  if (FAILED(enumerator->EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE, &collection))) {
    return {};
  }

  UINT deviceCount = 0;
  collection->GetCount(&deviceCount);

  for (UINT deviceIndex = 0; deviceIndex < deviceCount; ++deviceIndex) {
    ComPtr<IMMDevice> device;
    if (FAILED(collection->Item(deviceIndex, &device))) continue;

    ComPtr<IAudioSessionManager2> manager;
    if (FAILED(device->Activate(
          __uuidof(IAudioSessionManager2),
          CLSCTX_ALL,
          nullptr,
          reinterpret_cast<void**>(&manager)))) {
      continue;
    }

    ComPtr<IAudioSessionEnumerator> sessionEnumerator;
    if (FAILED(manager->GetSessionEnumerator(&sessionEnumerator))) continue;

    int sessionCount = 0;
    sessionEnumerator->GetCount(&sessionCount);

    for (int sessionIndex = 0; sessionIndex < sessionCount; ++sessionIndex) {
      ComPtr<IAudioSessionControl> control;
      if (FAILED(sessionEnumerator->GetSession(sessionIndex, &control))) continue;

      AudioSessionState state;
      if (FAILED(control->GetState(&state)) || state != AudioSessionStateActive) continue;

      ComPtr<IAudioSessionControl2> control2;
      if (FAILED(control->QueryInterface(
            __uuidof(IAudioSessionControl2),
            reinterpret_cast<void**>(&control2)))) {
        continue;
      }

      DWORD processId = 0;
      if (FAILED(control2->GetProcessId(&processId)) || processId == 0) continue;

      HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, processId);
      if (process == nullptr) continue;

      wchar_t buffer[MAX_PATH] = {};
      DWORD bufferSize = MAX_PATH;
      if (QueryFullProcessImageNameW(process, 0, buffer, &bufferSize)) {
        const std::wstring baseName = baseNameFromPath(std::wstring(buffer, bufferSize));
        const std::string utf8Name = wideToUtf8(baseName);
        if (!utf8Name.empty()) {
          result.insert(utf8Name);
        }
      }

      CloseHandle(process);
    }
  }

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
