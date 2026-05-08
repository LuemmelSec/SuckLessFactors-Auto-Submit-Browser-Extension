// interceptor.js — Runs in MAIN world (page context)
// Hooks XMLHttpRequest to capture CSRF tokens, assignmentId, shiftDate, attendanceType
// from SAP UI5's own requests. Dispatches CustomEvents that the content script (ISOLATED world) can hear.

(function () {
  var _open      = XMLHttpRequest.prototype.open;
  var _send      = XMLHttpRequest.prototype.send;
  var _setHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__sfUrl = typeof url === 'string' ? url : '';
    var m = this.__sfUrl.match(/assignmentId='(\d+)'/);
    if (m) {
      console.log('[SF-EXT interceptor] assignmentId from URL:', m[1]);
      window.dispatchEvent(new CustomEvent('__sf_aid__', { detail: m[1] }));
    }
    var s = this.__sfUrl.match(/shiftDate=(\d{4}-\d{2}-\d{2})/);
    if (s) {
      console.log('[SF-EXT interceptor] shiftDate from URL:', s[1]);
      window.dispatchEvent(new CustomEvent('__sf_shift__', { detail: s[1] }));
    }
    return _open.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (name.toLowerCase() === 'x-csrf-token' &&
        value && value !== 'Fetch' && value !== 'Required') {
      console.log('[SF-EXT interceptor] CSRF token intercepted');
      window.dispatchEvent(new CustomEvent('__sf_csrf__', { detail: value }));
    }
    return _setHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (typeof body === 'string') {
      // Capture attendanceTypeExternalCode from POST bodies
      if (body.includes('attendanceTypeExternalCode')) {
        var m = body.match(/"attendanceTypeExternalCode"\s*:\s*"([^"]+)"/);
        if (m) {
          console.log('[SF-EXT interceptor] attendanceType from body:', m[1]);
          window.dispatchEvent(new CustomEvent('__sf_atttype__', { detail: m[1] }));
        }
      }
      // Capture shiftDate from $batch bodies (week navigation)
      var sd = body.match(/shiftDate[=:](\d{4}-\d{2}-\d{2})/);
      if (sd) {
        console.log('[SF-EXT interceptor] shiftDate from body:', sd[1]);
        window.dispatchEvent(new CustomEvent('__sf_shift__', { detail: sd[1] }));
      }
      // Capture assignmentId from $batch bodies
      var aid = body.match(/assignmentId='(\d+)'/);
      if (aid) {
        console.log('[SF-EXT interceptor] assignmentId from body:', aid[1]);
        window.dispatchEvent(new CustomEvent('__sf_aid__', { detail: aid[1] }));
      }
    }
    return _send.apply(this, arguments);
  };

  console.log('[SF-EXT interceptor] ✓ XHR hooks installed (MAIN world)');
})();
