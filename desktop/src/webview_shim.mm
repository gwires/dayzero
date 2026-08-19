// Single translation unit that instantiates the vendored webview
// (webview/webview 0.12.0) implementation and exports its C API.
// .mm ensures Apple framework headers inside webview.h's #if __APPLE__
// block are handled by clang's ObjC-compatible front-end (the same
// way webview upstream bundles them).
#include "webview/webview.h"
