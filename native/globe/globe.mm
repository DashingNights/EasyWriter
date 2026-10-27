// clang++ -std=c++17 -ObjC++ -fobjc-arc -bundle -undefined dynamic_lookup -arch arm64 -arch x86_64 -mmacosx-version-min=13.0 -DNAPI_VERSION=8 -I"$NODE_INCLUDE" -framework AppKit native/globe/globe.mm -o native/globe/globe.node
//
// Globe+Tab and Globe+Space on a Mac (SPEC §7k). Electron never sees the Globe (fn) key, so this AppKit monitor watches the app's
// own key presses: Tab or Space with Globe held is swallowed and reported to JS as a packed number (bits 0-7 the key code, 8
// Shift, 9 Control, 10 Option, 11 Command, 12 a repeat). main.js watchGlobe sends it on to the renderer. Plain C N-API.

#import <AppKit/AppKit.h>
#include <node_api.h>

static napi_threadsafe_function tsfn = nullptr;
static id monitor = nil;

static void call_js(napi_env env, napi_value js_cb, void *, void *data) {
  uint32_t packed = (uint32_t)(uintptr_t)data;
  if (!env || !js_cb) return;
  napi_value undefined, arg;
  napi_get_undefined(env, &undefined);
  napi_create_uint32(env, packed, &arg);
  napi_call_function(env, undefined, js_cb, 1, &arg, nullptr);
}

static napi_value start(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value cb;
  napi_get_cb_info(env, info, &argc, &cb, nullptr, nullptr);
  napi_valuetype type;
  if (argc < 1 || napi_typeof(env, cb, &type) != napi_ok || type != napi_function) {
    napi_throw_type_error(env, nullptr, "start(callback) needs a function");
    return nullptr;
  }
  if (monitor) return nullptr; // started already
  napi_value name;
  napi_create_string_utf8(env, "globe", NAPI_AUTO_LENGTH, &name);
  if (napi_create_threadsafe_function(env, cb, nullptr, name, 0, 1, nullptr, nullptr, nullptr, call_js, &tsfn) != napi_ok) {
    napi_throw_error(env, nullptr, "could not create the callback");
    return nullptr;
  }
  napi_unref_threadsafe_function(env, tsfn); // the monitor never keeps the process alive
  dispatch_async(dispatch_get_main_queue(), ^{
    monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown handler:^NSEvent *(NSEvent *e) {
      NSEventModifierFlags f = e.modifierFlags;
      unsigned short code = e.keyCode;
      if (!(f & NSEventModifierFlagFunction) || (code != 48 && code != 49)) return e; // 48 Tab, 49 Space
      uint32_t packed = code | (f & NSEventModifierFlagShift ? 1u << 8 : 0) | (f & NSEventModifierFlagControl ? 1u << 9 : 0)
        | (f & NSEventModifierFlagOption ? 1u << 10 : 0) | (f & NSEventModifierFlagCommand ? 1u << 11 : 0) | (e.isARepeat ? 1u << 12 : 0);
      napi_call_threadsafe_function(tsfn, (void *)(uintptr_t)packed, napi_tsfn_nonblocking);
      return nil;
    }];
  });
  return nullptr;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "start", NAPI_AUTO_LENGTH, start, nullptr, &fn);
  napi_set_named_property(env, exports, "start", fn);
  return exports;
}

NAPI_MODULE(globe, init)
