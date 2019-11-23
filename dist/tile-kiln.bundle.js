// Wrapper for worker threads to enable a callback interface
// Inspired by https://codeburst.io/promises-for-the-web-worker-9311b7831733
function initWorker(codeHref) {

  const tasks = {};
  let globalMsgId = 0;
  let activeTasks = 0;

  const worker = new Worker(codeHref);
  worker.onmessage = handleMsg;

  return {
    startTask,
    cancelTask,
    numActive: () => activeTasks,
    terminate: worker.terminate,
  }

  function startTask(payload, callback) {
    activeTasks ++;
    const msgId = globalMsgId++;
    tasks[msgId] = { callback };
    worker.postMessage({ id: msgId, type: "start", payload });
    return msgId; // Returned ID can be used for later cancellation
  }

  function cancelTask(id) {
    if (tasks[id]) worker.postMessage({ id, type: "cancel" });
    return delete tasks[id];
  }

  function handleMsg(msgEvent) {
    const msg = msgEvent.data; // { id, type, key, payload }
    const task = tasks[msg.id];
    if (!task) return worker.postMessage({ id: msg.id, type: "cancel" });

    switch (msg.type) {
      case "error":
        task.callback(msg.payload);
        break; // Clean up below

      case "header":
        task.header = msg.payload;
        task.result = initJSON(msg.payload);
        return worker.postMessage({ id: msg.id, type: "continue" });

      case "data": 
        let features = task.result[msg.key].features;
        msg.payload.forEach( feature => features.push(feature) );
        return worker.postMessage({ id: msg.id, type: "continue" });

      case "done":
        let err = checkJSON(task.result, task.header)
          ? null
          : "ERROR: JSON from worker failed checks!";
        task.callback(err, task.result);
        break; // Clean up below

      default:
        task.callback("ERROR: worker sent bad message type!");
        break; // Clean up below
    }

    delete tasks[msg.id];
    activeTasks --;
  }
}

function initJSON(header) {
  const json = {};
  Object.keys(header).forEach(key => {
    json[key] = { type: "FeatureCollection", features: [] };
  });
  return json;
}

function checkJSON(json, header) {
  return Object.keys(header).every(checkFeatureCount);

  function checkFeatureCount(key) {
    return json[key].features.length === header[key];
  }
}

function initChainer() {
  const timeouts = [];

  const messageName = "zero-timeout-message";
  window.addEventListener("message", handleMessage, true);

  return {
    sortTasks,
    chainSyncList,
    chainAsyncList,
  };

  function sortTasks(ranking) {
    // Rank each task according to the supplied ranking function
    timeouts.forEach( task => { task.rank = ranking(task.id); } );
    // Sort tasks: smaller rank number (or undefined rank) first
    timeouts.sort( (a, b) => (a.rank > b.rank) ? 1 : -1 );
  }

  function chainSyncList(funcs, finalCallback, taskId) {
    // Input funcs is an array of synchronous zero-argument functions
    // Turn them into asynchronous functions taking a callback
    const cbFuncs = funcs.map( func => (cb) => {
      func();
      setZeroTimeout(cb, taskId);
    });

    // Execute them as a chain. Start the chain asynchronously
    setZeroTimeout( () => callInOrder(cbFuncs, finalCallback), taskId );
  }

  function chainAsyncList(funcs, finalCallback, taskId) {
    // Input funcs is an array of functions taking a callback as an argument.
    // Wrap them to make the callbacks asynchronous and ID'd
    const wrapFuncs = funcs.map( func => (cb) => {
      func( () => setZeroTimeout(cb, taskId) );
    });

    // Execute them as a chain. Start the chain asynchronously
    setZeroTimeout( () => callInOrder(wrapFuncs, finalCallback), taskId );
  }

  // http://derpturkey.com/chained-callback-pattern-in-javascript/
  function callInOrder(funcs, finalCallback) {
    funcs.push(finalCallback);
    chain(funcs.shift());

    function chain(func) {
      if (func) func( () => chain(funcs.shift()) );
    }
  }

  // https://dbaron.org/log/20100309-faster-timeouts
  // func is a function taking zero arguments
  function setZeroTimeout(func, id) {
    timeouts.push({ id, func, rank: 0 });

    // Don't let this message be picked up by another window:
    // set the targetOrigin to the current window origin
    let loc = window.location;
    let targetOrigin = loc.protocol + "//" + loc.hostname;
    if (loc.port !== "") targetOrigin += ":" + loc.port;

    window.postMessage(messageName, targetOrigin);
  }

  function handleMessage(evnt) {
    if (evnt.source != window || evnt.data !== messageName) return;
    evnt.stopPropagation();
    if (timeouts.length < 1) return;

    let task = timeouts.shift();
    // If task rank is undefined, this task has been canceled.
    if (task.rank !== undefined) task.func();
  }
}

function getJSON(dataHref) {
  // Wrap the fetch API to force a rejected promise if response is not OK
  const checkResponse = (response) => (response.ok)
    ? response.json()
    : Promise.reject(response); // Can check .status on returned response

  return fetch(dataHref).then(checkResponse);
}

function getImage(href) {
  const errMsg = "ERROR in getImage for href " + href;
  const img = new Image();

  return new Promise( (resolve, reject) => {
    img.onerror = () => reject(errMsg);

    img.onload = () => (img.complete && img.naturalWidth !== 0)
        ? resolve(img)
        : reject(errMsg);

    img.crossOrigin = "anonymous";
    img.src = href;
  });
}

// From mapbox-gl-js, style-spec/deref.js
const refProperties = [
  'type', 
  'source', 
  'source-layer', 
  'minzoom', 
  'maxzoom', 
  'filter', 
  'layout'
];

function expandLayerReferences(styleDoc) {
  styleDoc.layers = derefLayers(styleDoc.layers);
  return styleDoc;
}

/**
 * Given an array of layers, some of which may contain `ref` properties
 * whose value is the `id` of another property, return a new array where
 * such layers have been augmented with the 'type', 'source', etc. properties
 * from the parent layer, and the `ref` property has been removed.
 *
 * The input is not modified. The output may contain references to portions
 * of the input.
 */
function derefLayers(layers) {
  layers = layers.slice(); // ??? What are we trying to achieve here?

  const map = Object.create(null); // stackoverflow.com/a/21079232/10082269
  layers.forEach( layer => { map[layer.id] = layer; } );

  for (let i = 0; i < layers.length; i++) {
    if ('ref' in layers[i]) {
      layers[i] = deref(layers[i], map[layers[i].ref]);
    }
  }

  return layers;
}

function deref(layer, parent) {
  const result = {};

  for (const k in layer) {
    if (k !== 'ref') {
      result[k] = layer[k];
    }
  }

  refProperties.forEach((k) => {
    if (k in parent) {
      result[k] = parent[k];
    }
  });

  return result;
}

function expandStyleURL(url, token) {
  var prefix = /^mapbox:\/\/styles\//;
  if ( !url.match(prefix) ) return url;
  var apiRoot = "https://api.mapbox.com/styles/v1/";
  return url.replace(prefix, apiRoot) + "?access_token=" + token;
}

function expandSpriteURLs(url, token) {
  // Returns an array containing urls to .png and .json files
  var prefix = /^mapbox:\/\/sprites\//;
  if ( !url.match(prefix) ) return {
    image: url + ".png", 
    meta: url + ".json",
  };

  // We have a Mapbox custom url. Expand to an absolute URL, as per the spec
  var apiRoot = "https://api.mapbox.com/styles/v1/";
  url = url.replace(prefix, apiRoot) + "/sprite";
  var tokenString = "?access_token=" + token;
  return {
    image: url + ".png" + tokenString, 
    meta: url + ".json" + tokenString,
  };
}

function expandTileURL(url, token) {
  var prefix = /^mapbox:\/\//;
  if ( !url.match(prefix) ) return url;
  var apiRoot = "https://api.mapbox.com/v4/";
  return url.replace(prefix, apiRoot) + ".json?secure&access_token=" + token;
}

function createCommonjsModule(fn, module) {
	return module = { exports: {} }, fn(module, module.exports), module.exports;
}

var csscolorparser = createCommonjsModule(function (module, exports) {
// (c) Dean McNamee <dean@gmail.com>, 2012.
//
// https://github.com/deanm/css-color-parser-js
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to
// deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
// sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
// FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
// IN THE SOFTWARE.

// http://www.w3.org/TR/css3-color/
var kCSSColorTable = {
  "transparent": [0,0,0,0], "aliceblue": [240,248,255,1],
  "antiquewhite": [250,235,215,1], "aqua": [0,255,255,1],
  "aquamarine": [127,255,212,1], "azure": [240,255,255,1],
  "beige": [245,245,220,1], "bisque": [255,228,196,1],
  "black": [0,0,0,1], "blanchedalmond": [255,235,205,1],
  "blue": [0,0,255,1], "blueviolet": [138,43,226,1],
  "brown": [165,42,42,1], "burlywood": [222,184,135,1],
  "cadetblue": [95,158,160,1], "chartreuse": [127,255,0,1],
  "chocolate": [210,105,30,1], "coral": [255,127,80,1],
  "cornflowerblue": [100,149,237,1], "cornsilk": [255,248,220,1],
  "crimson": [220,20,60,1], "cyan": [0,255,255,1],
  "darkblue": [0,0,139,1], "darkcyan": [0,139,139,1],
  "darkgoldenrod": [184,134,11,1], "darkgray": [169,169,169,1],
  "darkgreen": [0,100,0,1], "darkgrey": [169,169,169,1],
  "darkkhaki": [189,183,107,1], "darkmagenta": [139,0,139,1],
  "darkolivegreen": [85,107,47,1], "darkorange": [255,140,0,1],
  "darkorchid": [153,50,204,1], "darkred": [139,0,0,1],
  "darksalmon": [233,150,122,1], "darkseagreen": [143,188,143,1],
  "darkslateblue": [72,61,139,1], "darkslategray": [47,79,79,1],
  "darkslategrey": [47,79,79,1], "darkturquoise": [0,206,209,1],
  "darkviolet": [148,0,211,1], "deeppink": [255,20,147,1],
  "deepskyblue": [0,191,255,1], "dimgray": [105,105,105,1],
  "dimgrey": [105,105,105,1], "dodgerblue": [30,144,255,1],
  "firebrick": [178,34,34,1], "floralwhite": [255,250,240,1],
  "forestgreen": [34,139,34,1], "fuchsia": [255,0,255,1],
  "gainsboro": [220,220,220,1], "ghostwhite": [248,248,255,1],
  "gold": [255,215,0,1], "goldenrod": [218,165,32,1],
  "gray": [128,128,128,1], "green": [0,128,0,1],
  "greenyellow": [173,255,47,1], "grey": [128,128,128,1],
  "honeydew": [240,255,240,1], "hotpink": [255,105,180,1],
  "indianred": [205,92,92,1], "indigo": [75,0,130,1],
  "ivory": [255,255,240,1], "khaki": [240,230,140,1],
  "lavender": [230,230,250,1], "lavenderblush": [255,240,245,1],
  "lawngreen": [124,252,0,1], "lemonchiffon": [255,250,205,1],
  "lightblue": [173,216,230,1], "lightcoral": [240,128,128,1],
  "lightcyan": [224,255,255,1], "lightgoldenrodyellow": [250,250,210,1],
  "lightgray": [211,211,211,1], "lightgreen": [144,238,144,1],
  "lightgrey": [211,211,211,1], "lightpink": [255,182,193,1],
  "lightsalmon": [255,160,122,1], "lightseagreen": [32,178,170,1],
  "lightskyblue": [135,206,250,1], "lightslategray": [119,136,153,1],
  "lightslategrey": [119,136,153,1], "lightsteelblue": [176,196,222,1],
  "lightyellow": [255,255,224,1], "lime": [0,255,0,1],
  "limegreen": [50,205,50,1], "linen": [250,240,230,1],
  "magenta": [255,0,255,1], "maroon": [128,0,0,1],
  "mediumaquamarine": [102,205,170,1], "mediumblue": [0,0,205,1],
  "mediumorchid": [186,85,211,1], "mediumpurple": [147,112,219,1],
  "mediumseagreen": [60,179,113,1], "mediumslateblue": [123,104,238,1],
  "mediumspringgreen": [0,250,154,1], "mediumturquoise": [72,209,204,1],
  "mediumvioletred": [199,21,133,1], "midnightblue": [25,25,112,1],
  "mintcream": [245,255,250,1], "mistyrose": [255,228,225,1],
  "moccasin": [255,228,181,1], "navajowhite": [255,222,173,1],
  "navy": [0,0,128,1], "oldlace": [253,245,230,1],
  "olive": [128,128,0,1], "olivedrab": [107,142,35,1],
  "orange": [255,165,0,1], "orangered": [255,69,0,1],
  "orchid": [218,112,214,1], "palegoldenrod": [238,232,170,1],
  "palegreen": [152,251,152,1], "paleturquoise": [175,238,238,1],
  "palevioletred": [219,112,147,1], "papayawhip": [255,239,213,1],
  "peachpuff": [255,218,185,1], "peru": [205,133,63,1],
  "pink": [255,192,203,1], "plum": [221,160,221,1],
  "powderblue": [176,224,230,1], "purple": [128,0,128,1],
  "rebeccapurple": [102,51,153,1],
  "red": [255,0,0,1], "rosybrown": [188,143,143,1],
  "royalblue": [65,105,225,1], "saddlebrown": [139,69,19,1],
  "salmon": [250,128,114,1], "sandybrown": [244,164,96,1],
  "seagreen": [46,139,87,1], "seashell": [255,245,238,1],
  "sienna": [160,82,45,1], "silver": [192,192,192,1],
  "skyblue": [135,206,235,1], "slateblue": [106,90,205,1],
  "slategray": [112,128,144,1], "slategrey": [112,128,144,1],
  "snow": [255,250,250,1], "springgreen": [0,255,127,1],
  "steelblue": [70,130,180,1], "tan": [210,180,140,1],
  "teal": [0,128,128,1], "thistle": [216,191,216,1],
  "tomato": [255,99,71,1], "turquoise": [64,224,208,1],
  "violet": [238,130,238,1], "wheat": [245,222,179,1],
  "white": [255,255,255,1], "whitesmoke": [245,245,245,1],
  "yellow": [255,255,0,1], "yellowgreen": [154,205,50,1]};

function clamp_css_byte(i) {  // Clamp to integer 0 .. 255.
  i = Math.round(i);  // Seems to be what Chrome does (vs truncation).
  return i < 0 ? 0 : i > 255 ? 255 : i;
}

function clamp_css_float(f) {  // Clamp to float 0.0 .. 1.0.
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

function parse_css_int(str) {  // int or percentage.
  if (str[str.length - 1] === '%')
    return clamp_css_byte(parseFloat(str) / 100 * 255);
  return clamp_css_byte(parseInt(str));
}

function parse_css_float(str) {  // float or percentage.
  if (str[str.length - 1] === '%')
    return clamp_css_float(parseFloat(str) / 100);
  return clamp_css_float(parseFloat(str));
}

function css_hue_to_rgb(m1, m2, h) {
  if (h < 0) h += 1;
  else if (h > 1) h -= 1;

  if (h * 6 < 1) return m1 + (m2 - m1) * h * 6;
  if (h * 2 < 1) return m2;
  if (h * 3 < 2) return m1 + (m2 - m1) * (2/3 - h) * 6;
  return m1;
}

function parseCSSColor(css_str) {
  // Remove all whitespace, not compliant, but should just be more accepting.
  var str = css_str.replace(/ /g, '').toLowerCase();

  // Color keywords (and transparent) lookup.
  if (str in kCSSColorTable) return kCSSColorTable[str].slice();  // dup.

  // #abc and #abc123 syntax.
  if (str[0] === '#') {
    if (str.length === 4) {
      var iv = parseInt(str.substr(1), 16);  // TODO(deanm): Stricter parsing.
      if (!(iv >= 0 && iv <= 0xfff)) return null;  // Covers NaN.
      return [((iv & 0xf00) >> 4) | ((iv & 0xf00) >> 8),
              (iv & 0xf0) | ((iv & 0xf0) >> 4),
              (iv & 0xf) | ((iv & 0xf) << 4),
              1];
    } else if (str.length === 7) {
      var iv = parseInt(str.substr(1), 16);  // TODO(deanm): Stricter parsing.
      if (!(iv >= 0 && iv <= 0xffffff)) return null;  // Covers NaN.
      return [(iv & 0xff0000) >> 16,
              (iv & 0xff00) >> 8,
              iv & 0xff,
              1];
    }

    return null;
  }

  var op = str.indexOf('('), ep = str.indexOf(')');
  if (op !== -1 && ep + 1 === str.length) {
    var fname = str.substr(0, op);
    var params = str.substr(op+1, ep-(op+1)).split(',');
    var alpha = 1;  // To allow case fallthrough.
    switch (fname) {
      case 'rgba':
        if (params.length !== 4) return null;
        alpha = parse_css_float(params.pop());
        // Fall through.
      case 'rgb':
        if (params.length !== 3) return null;
        return [parse_css_int(params[0]),
                parse_css_int(params[1]),
                parse_css_int(params[2]),
                alpha];
      case 'hsla':
        if (params.length !== 4) return null;
        alpha = parse_css_float(params.pop());
        // Fall through.
      case 'hsl':
        if (params.length !== 3) return null;
        var h = (((parseFloat(params[0]) % 360) + 360) % 360) / 360;  // 0 .. 1
        // NOTE(deanm): According to the CSS spec s/l should only be
        // percentages, but we don't bother and let float or percentage.
        var s = parse_css_float(params[1]);
        var l = parse_css_float(params[2]);
        var m2 = l <= 0.5 ? l * (s + 1) : l + s - l * s;
        var m1 = l * 2 - m2;
        return [clamp_css_byte(css_hue_to_rgb(m1, m2, h+1/3) * 255),
                clamp_css_byte(css_hue_to_rgb(m1, m2, h) * 255),
                clamp_css_byte(css_hue_to_rgb(m1, m2, h-1/3) * 255),
                alpha];
      default:
        return null;
    }
  }

  return null;
}

try { exports.parseCSSColor = parseCSSColor; } catch(e) { }
});
var csscolorparser_1 = csscolorparser.parseCSSColor;

function collectGetters(properties = {}, keyDefaultPairs) {
  const getters = {};
  keyDefaultPairs.forEach( ([key, defaultVal]) => {
    getters[key] = buildStyleFunc(properties[key], defaultVal);
  });
  return getters;
}

function buildStyleFunc(style, defaultVal) {
  var styleFunc, getArg;

  if (style === undefined) {
    styleFunc = () => defaultVal;
    styleFunc.type = "constant";

  } else if (typeof style !== "object" || Array.isArray(style)) {
    styleFunc = () => style;
    styleFunc.type = "constant";

  } else if (!style.property || style.property === "zoom") {
    getArg = (zoom, feature) => zoom;
    styleFunc = getStyleFunc(style, getArg);
    styleFunc.type = "zoom";

  } else {
    getArg = (zoom, feature) => feature.properties[style.property];
    styleFunc = getStyleFunc(style, getArg);
    styleFunc.type = "property";

  } // NOT IMPLEMENTED: zoom-and-property functions

  return styleFunc;
}

function getStyleFunc(style, getArg) {
  if (style.type === "identity") return getArg;

  // We should be building a stop function now. Make sure we have enough info
  var stops = style.stops;
  if (!stops || stops.length < 2 || stops[0].length !== 2) {
    console.log("buildStyleFunc: style = " + JSON.stringify(style));
    console.log("ERROR in buildStyleFunc: failed to understand style!");
    return;
  }

  var stopFunc = buildStopFunc(stops, style.base);
  return (zoom, feature) => stopFunc( getArg(zoom, feature) );
}

function buildStopFunc(stops, base = 1) {
  const izm = stops.length - 1;
  const interpolate = getInterpolator(stops[0][1]);

  return function(x) {
    let iz = stops.findIndex(stop => stop[0] > x);

    if (iz === 0) return stops[0][1]; // x is below first stop
    if (iz < 0) return stops[izm][1]; // x is above last stop

    let t = interpFactor(base, stops[iz-1][0], x, stops[iz][0]);

    return interpolate(stops[iz-1][1], stops[iz][1], t);
  }
}

function getInterpolator(sampleVal) {
  var type = typeof sampleVal;

  // Linear interpolator for numbers
  if (type === "number") return (v1, v2, t) => v1 + t * (v2 - v1);

  var isColor = (type === "string" && csscolorparser_1(sampleVal));
  return (isColor)
    ? (v1, v2, t) => interpColor(csscolorparser_1(v1), csscolorparser_1(v2), t)
    : (v1, v2, t) => v1; // Assume step function for other types
}

function interpFactor(base, x0, x, x1) {
  // Follows mapbox-gl-js, style-spec/function/index.js.
  // NOTE: https://github.com/mapbox/mapbox-gl-js/issues/2698 not addressed!
  const range = x1 - x0;
  if (range === 0) return 0;

  const dx = x - x0;
  if (base === 1) return dx / range;

  return (Math.pow(base, dx) - 1) / (Math.pow(base, range) - 1);
}

function interpColor(c0, c1, t) {
  // Inputs c0, c1 are 4-element RGBA arrays as returned by parseCSSColor
  let c = [];
  for (let i = 0; i < 4; i++) {
    c[i] = c0[i] + t * (c1[i] - c0[i]);
  }
  return "rgba(" +
    Math.round(c[0]) + ", " +
    Math.round(c[1]) + ", " + 
    Math.round(c[2]) + ", " +
    c[3] + ")";
}

// Renders layers that cover the whole tile (like painting with a roller)

function initBackgroundFill(style, canvSize) {
  const paint = collectGetters(style.paint, [
    ["background-color"],
    ["background-opacity"],
  ]);

  return function(ctx, zoom) {
    ctx.fillStyle = paint["background-color"](zoom);
    ctx.globalAlpha = paint["background-opacity"](zoom);
    ctx.fillRect(0, 0, canvSize, canvSize);
  }
}

function initRasterFill(style, canvSize) {
  const paint = collectGetters(style.paint, [
    ["raster-opacity"],
    // ["raster-hue-rotate"],
    // ["raster-brightness-min"],
    // ["raster-brightness-max"],
    // ["raster-saturation"],
    // ["raster-contrast"],
  ]);

  return function(ctx, zoom, image) {
    ctx.globalAlpha = paint["raster-opacity"](zoom);
    // TODO: we are forcing one tile to cover the canvas!
    // In some cases (e.g. Mapbox Satellite Streets) the raster tiles may
    // be half the size of the vector canvas, so we need 4 of them...
    ctx.drawImage(image, 0, 0, canvSize, canvSize);
  }
}

function getSetter(styleProperty, setter) {
  // For each relevant style property, return functions to:
  // 1. Get the style value. This function could depend on the data
  //    (feature.properties), or only on the zoom level.
  const getStyle = buildStyleFunc(styleProperty);

  // 2. Set the Canvas/d3-path state based on the style value. In general,
  //    the setter signature is setState(val, context, path)
  const setState = (typeof setter === "string")
    ? (val, ctx) => { ctx[setter] = val; } // Default setter sets Canvas state
    : setter;

  // These 2 functions will be composed, i.e., setState(getStyle(...), ...)
  // But we return them separately for now, since we may want to use the style
  // values first, e.g. for sorting the data
  return { getStyle, setState };
}

function getSetters(style) {
  const layout = style.layout;
  const paint = style.paint;
  const setters = [], methods = [];

  switch (style.type) {
    case "circle":
      let setRadius = (radius, ctx, path) => { 
        if (radius) path.pointRadius(radius); 
      };
      setters.push(
        getSetter(paint["circle-radius"], setRadius),
        getSetter(paint["circle-color"], "fillStyle"),
        getSetter(paint["circle-opacity"], "globalAlpha"),
      );
      methods.push("fill");
      break;

    case "line":
      if (layout) setters.push(
        getSetter(layout["line-cap"], "lineCap"),
        getSetter(layout["line-join"], "lineJoin"),
        getSetter(layout["line-miter-limit"], "miterLimit"),
        // line-round-limit,
      );
      setters.push(
        getSetter(paint["line-width"], "lineWidth"),
        getSetter(paint["line-opacity"], "globalAlpha"),
        getSetter(paint["line-color"], "strokeStyle"),
        // line-gap-width, 
        // line-translate, line-translate-anchor,
        // line-offset, line-blur, line-gradient, line-pattern, 
        // line-dasharray
      );
      methods.push("stroke");
      break;

    case "fill":
      setters.push(
        getSetter(paint["fill-color"], "fillStyle"),
        getSetter(paint["fill-opacity"], "globalAlpha"),
        // fill-outline-color, 
        // fill-translate, 
        // fill-translate-anchor,
        // fill-pattern,
      );
      methods.push("fill");
      break;

    default:
      // Missing fill-extrusion, heatmap, hillshade
      return console.log("ERROR in initBrush: layer.type = " +
        style.type + " not supported!");
  }

  // Sort the getter/setter pairs based on whether they are data dependent
  const dataFuncs = setters.filter(s => s.getStyle.type === "property");
  // zoomFuncs could include constant styles
  const zoomFuncs = setters.filter(s => s.getStyle.type !== "property");

  return { dataFuncs, zoomFuncs, methods };
}

// Adds floating point numbers with twice the normal precision.
// Reference: J. R. Shewchuk, Adaptive Precision Floating-Point Arithmetic and
// Fast Robust Geometric Predicates, Discrete & Computational Geometry 18(3)
// 305–363 (1997).
// Code adapted from GeographicLib by Charles F. F. Karney,
// http://geographiclib.sourceforge.net/

function adder() {
  return new Adder;
}

function Adder() {
  this.reset();
}

Adder.prototype = {
  constructor: Adder,
  reset: function() {
    this.s = // rounded value
    this.t = 0; // exact error
  },
  add: function(y) {
    add(temp, y, this.t);
    add(this, temp.s, this.s);
    if (this.s) this.t += temp.t;
    else this.s = temp.t;
  },
  valueOf: function() {
    return this.s;
  }
};

var temp = new Adder;

function add(adder, a, b) {
  var x = adder.s = a + b,
      bv = x - a,
      av = x - bv;
  adder.t = (a - av) + (b - bv);
}

var pi = Math.PI;
var tau = pi * 2;

var abs = Math.abs;
var sqrt = Math.sqrt;

function noop() {}

function streamGeometry(geometry, stream) {
  if (geometry && streamGeometryType.hasOwnProperty(geometry.type)) {
    streamGeometryType[geometry.type](geometry, stream);
  }
}

var streamObjectType = {
  Feature: function(object, stream) {
    streamGeometry(object.geometry, stream);
  },
  FeatureCollection: function(object, stream) {
    var features = object.features, i = -1, n = features.length;
    while (++i < n) streamGeometry(features[i].geometry, stream);
  }
};

var streamGeometryType = {
  Sphere: function(object, stream) {
    stream.sphere();
  },
  Point: function(object, stream) {
    object = object.coordinates;
    stream.point(object[0], object[1], object[2]);
  },
  MultiPoint: function(object, stream) {
    var coordinates = object.coordinates, i = -1, n = coordinates.length;
    while (++i < n) object = coordinates[i], stream.point(object[0], object[1], object[2]);
  },
  LineString: function(object, stream) {
    streamLine(object.coordinates, stream, 0);
  },
  MultiLineString: function(object, stream) {
    var coordinates = object.coordinates, i = -1, n = coordinates.length;
    while (++i < n) streamLine(coordinates[i], stream, 0);
  },
  Polygon: function(object, stream) {
    streamPolygon(object.coordinates, stream);
  },
  MultiPolygon: function(object, stream) {
    var coordinates = object.coordinates, i = -1, n = coordinates.length;
    while (++i < n) streamPolygon(coordinates[i], stream);
  },
  GeometryCollection: function(object, stream) {
    var geometries = object.geometries, i = -1, n = geometries.length;
    while (++i < n) streamGeometry(geometries[i], stream);
  }
};

function streamLine(coordinates, stream, closed) {
  var i = -1, n = coordinates.length - closed, coordinate;
  stream.lineStart();
  while (++i < n) coordinate = coordinates[i], stream.point(coordinate[0], coordinate[1], coordinate[2]);
  stream.lineEnd();
}

function streamPolygon(coordinates, stream) {
  var i = -1, n = coordinates.length;
  stream.polygonStart();
  while (++i < n) streamLine(coordinates[i], stream, 1);
  stream.polygonEnd();
}

function geoStream(object, stream) {
  if (object && streamObjectType.hasOwnProperty(object.type)) {
    streamObjectType[object.type](object, stream);
  } else {
    streamGeometry(object, stream);
  }
}

function identity(x) {
  return x;
}

var areaSum = adder(),
    areaRingSum = adder(),
    x00,
    y00,
    x0,
    y0;

var areaStream = {
  point: noop,
  lineStart: noop,
  lineEnd: noop,
  polygonStart: function() {
    areaStream.lineStart = areaRingStart;
    areaStream.lineEnd = areaRingEnd;
  },
  polygonEnd: function() {
    areaStream.lineStart = areaStream.lineEnd = areaStream.point = noop;
    areaSum.add(abs(areaRingSum));
    areaRingSum.reset();
  },
  result: function() {
    var area = areaSum / 2;
    areaSum.reset();
    return area;
  }
};

function areaRingStart() {
  areaStream.point = areaPointFirst;
}

function areaPointFirst(x, y) {
  areaStream.point = areaPoint;
  x00 = x0 = x, y00 = y0 = y;
}

function areaPoint(x, y) {
  areaRingSum.add(y0 * x - x0 * y);
  x0 = x, y0 = y;
}

function areaRingEnd() {
  areaPoint(x00, y00);
}

var x0$1 = Infinity,
    y0$1 = x0$1,
    x1 = -x0$1,
    y1 = x1;

var boundsStream = {
  point: boundsPoint,
  lineStart: noop,
  lineEnd: noop,
  polygonStart: noop,
  polygonEnd: noop,
  result: function() {
    var bounds = [[x0$1, y0$1], [x1, y1]];
    x1 = y1 = -(y0$1 = x0$1 = Infinity);
    return bounds;
  }
};

function boundsPoint(x, y) {
  if (x < x0$1) x0$1 = x;
  if (x > x1) x1 = x;
  if (y < y0$1) y0$1 = y;
  if (y > y1) y1 = y;
}

// TODO Enforce positive area for exterior, negative area for interior?

var X0 = 0,
    Y0 = 0,
    Z0 = 0,
    X1 = 0,
    Y1 = 0,
    Z1 = 0,
    X2 = 0,
    Y2 = 0,
    Z2 = 0,
    x00$1,
    y00$1,
    x0$2,
    y0$2;

var centroidStream = {
  point: centroidPoint,
  lineStart: centroidLineStart,
  lineEnd: centroidLineEnd,
  polygonStart: function() {
    centroidStream.lineStart = centroidRingStart;
    centroidStream.lineEnd = centroidRingEnd;
  },
  polygonEnd: function() {
    centroidStream.point = centroidPoint;
    centroidStream.lineStart = centroidLineStart;
    centroidStream.lineEnd = centroidLineEnd;
  },
  result: function() {
    var centroid = Z2 ? [X2 / Z2, Y2 / Z2]
        : Z1 ? [X1 / Z1, Y1 / Z1]
        : Z0 ? [X0 / Z0, Y0 / Z0]
        : [NaN, NaN];
    X0 = Y0 = Z0 =
    X1 = Y1 = Z1 =
    X2 = Y2 = Z2 = 0;
    return centroid;
  }
};

function centroidPoint(x, y) {
  X0 += x;
  Y0 += y;
  ++Z0;
}

function centroidLineStart() {
  centroidStream.point = centroidPointFirstLine;
}

function centroidPointFirstLine(x, y) {
  centroidStream.point = centroidPointLine;
  centroidPoint(x0$2 = x, y0$2 = y);
}

function centroidPointLine(x, y) {
  var dx = x - x0$2, dy = y - y0$2, z = sqrt(dx * dx + dy * dy);
  X1 += z * (x0$2 + x) / 2;
  Y1 += z * (y0$2 + y) / 2;
  Z1 += z;
  centroidPoint(x0$2 = x, y0$2 = y);
}

function centroidLineEnd() {
  centroidStream.point = centroidPoint;
}

function centroidRingStart() {
  centroidStream.point = centroidPointFirstRing;
}

function centroidRingEnd() {
  centroidPointRing(x00$1, y00$1);
}

function centroidPointFirstRing(x, y) {
  centroidStream.point = centroidPointRing;
  centroidPoint(x00$1 = x0$2 = x, y00$1 = y0$2 = y);
}

function centroidPointRing(x, y) {
  var dx = x - x0$2,
      dy = y - y0$2,
      z = sqrt(dx * dx + dy * dy);

  X1 += z * (x0$2 + x) / 2;
  Y1 += z * (y0$2 + y) / 2;
  Z1 += z;

  z = y0$2 * x - x0$2 * y;
  X2 += z * (x0$2 + x);
  Y2 += z * (y0$2 + y);
  Z2 += z * 3;
  centroidPoint(x0$2 = x, y0$2 = y);
}

function PathContext(context) {
  this._context = context;
}

PathContext.prototype = {
  _radius: 4.5,
  pointRadius: function(_) {
    return this._radius = _, this;
  },
  polygonStart: function() {
    this._line = 0;
  },
  polygonEnd: function() {
    this._line = NaN;
  },
  lineStart: function() {
    this._point = 0;
  },
  lineEnd: function() {
    if (this._line === 0) this._context.closePath();
    this._point = NaN;
  },
  point: function(x, y) {
    switch (this._point) {
      case 0: {
        this._context.moveTo(x, y);
        this._point = 1;
        break;
      }
      case 1: {
        this._context.lineTo(x, y);
        break;
      }
      default: {
        this._context.moveTo(x + this._radius, y);
        this._context.arc(x, y, this._radius, 0, tau);
        break;
      }
    }
  },
  result: noop
};

var lengthSum = adder(),
    lengthRing,
    x00$2,
    y00$2,
    x0$3,
    y0$3;

var lengthStream = {
  point: noop,
  lineStart: function() {
    lengthStream.point = lengthPointFirst;
  },
  lineEnd: function() {
    if (lengthRing) lengthPoint(x00$2, y00$2);
    lengthStream.point = noop;
  },
  polygonStart: function() {
    lengthRing = true;
  },
  polygonEnd: function() {
    lengthRing = null;
  },
  result: function() {
    var length = +lengthSum;
    lengthSum.reset();
    return length;
  }
};

function lengthPointFirst(x, y) {
  lengthStream.point = lengthPoint;
  x00$2 = x0$3 = x, y00$2 = y0$3 = y;
}

function lengthPoint(x, y) {
  x0$3 -= x, y0$3 -= y;
  lengthSum.add(sqrt(x0$3 * x0$3 + y0$3 * y0$3));
  x0$3 = x, y0$3 = y;
}

function PathString() {
  this._string = [];
}

PathString.prototype = {
  _radius: 4.5,
  _circle: circle(4.5),
  pointRadius: function(_) {
    if ((_ = +_) !== this._radius) this._radius = _, this._circle = null;
    return this;
  },
  polygonStart: function() {
    this._line = 0;
  },
  polygonEnd: function() {
    this._line = NaN;
  },
  lineStart: function() {
    this._point = 0;
  },
  lineEnd: function() {
    if (this._line === 0) this._string.push("Z");
    this._point = NaN;
  },
  point: function(x, y) {
    switch (this._point) {
      case 0: {
        this._string.push("M", x, ",", y);
        this._point = 1;
        break;
      }
      case 1: {
        this._string.push("L", x, ",", y);
        break;
      }
      default: {
        if (this._circle == null) this._circle = circle(this._radius);
        this._string.push("M", x, ",", y, this._circle);
        break;
      }
    }
  },
  result: function() {
    if (this._string.length) {
      var result = this._string.join("");
      this._string = [];
      return result;
    } else {
      return null;
    }
  }
};

function circle(radius) {
  return "m0," + radius
      + "a" + radius + "," + radius + " 0 1,1 0," + -2 * radius
      + "a" + radius + "," + radius + " 0 1,1 0," + 2 * radius
      + "z";
}

function index(projection, context) {
  var pointRadius = 4.5,
      projectionStream,
      contextStream;

  function path(object) {
    if (object) {
      if (typeof pointRadius === "function") contextStream.pointRadius(+pointRadius.apply(this, arguments));
      geoStream(object, projectionStream(contextStream));
    }
    return contextStream.result();
  }

  path.area = function(object) {
    geoStream(object, projectionStream(areaStream));
    return areaStream.result();
  };

  path.measure = function(object) {
    geoStream(object, projectionStream(lengthStream));
    return lengthStream.result();
  };

  path.bounds = function(object) {
    geoStream(object, projectionStream(boundsStream));
    return boundsStream.result();
  };

  path.centroid = function(object) {
    geoStream(object, projectionStream(centroidStream));
    return centroidStream.result();
  };

  path.projection = function(_) {
    return arguments.length ? (projectionStream = _ == null ? (projection = null, identity) : (projection = _).stream, path) : projection;
  };

  path.context = function(_) {
    if (!arguments.length) return context;
    contextStream = _ == null ? (context = null, new PathString) : new PathContext(context = _);
    if (typeof pointRadius !== "function") contextStream.pointRadius(pointRadius);
    return path;
  };

  path.pointRadius = function(_) {
    if (!arguments.length) return pointRadius;
    pointRadius = typeof _ === "function" ? _ : (contextStream.pointRadius(+_), +_);
    return path;
  };

  return path.projection(projection).context(context);
}

function initBrush(style) {
  const { dataFuncs, zoomFuncs, methods } = getSetters(style);

  const setZoomFuncs = (zoom, ctx, path) => zoomFuncs.forEach(f => {
    return f.setState(f.getStyle(zoom), ctx, path);
  });

  const prepData = (dataFuncs.length > 0)
    ? (zoom, data) => addStylesToFeatures(dataFuncs, zoom, data)
    : (zoom, data) => data;

  // Choose render function
  const draw = (dataFuncs.length > 0)
    ? (ctx, path, data) => drawVarying(data, ctx, path, methods, dataFuncs)
    : (ctx, path, data) => drawConstant(data, ctx, path, methods);

  return function(ctx, zoom, data) {
    const path = index(null, ctx);

    // Set the non-data-dependent state
    setZoomFuncs(zoom, ctx, path);

    // Prepare the data, computing data-dependent styles if needed
    const preppedData = prepData(zoom, data);

    // Draw everything and return
    return draw(ctx, path, preppedData);
  }
}

function addStylesToFeatures(propFuncs, zoom, data) {
  // Build an array of features, adding style values and a sortable id
  // WARNING: modifies the features in the original data object!
  let styledFeatures = data.features.map(feature => {
    feature.styles = propFuncs.map(f => f.getStyle(zoom, feature));
    feature.styleID = feature.styles.join("|");
    return feature;
  });

  // Sort the array, to collect features with the same styling
  styledFeatures.sort( (a, b) => (a.styleID < b.styleID) ? -1 : 1 );

  // Return a valid GeoJSON Feature Collection
  return { type: "FeatureCollection", features: styledFeatures };
}

function drawConstant(data, ctx, path, methods) {
  // Draw all the data with the current canvas state
  ctx.beginPath();
  path(data);
  methods.forEach(method => ctx[method]());
}

function drawVarying(data, ctx, path, methods, propFuncs) {
  // Draw features, updating canvas state as data-dependent styles change

  let numFeatures = data.features.length;
  let i = 0;
  while (i < numFeatures) {
    // Set state based on the styles of the current feature
    let styles = data.features[i].styles;
    propFuncs.forEach( (f, j) => f.setState(styles[j], ctx, path) );

    ctx.beginPath();
    // Add features to the path, until the styles change
    let id = data.features[i].styleID;
    while (i < numFeatures && data.features[i].styleID === id) {
      path(data.features[i]);
      i++;
    }

    // Render the current path
    methods.forEach(method => ctx[method]());
  }
}

function getTokenParser(tokenText) {
  if (!tokenText) return () => undefined;
  const tokenPattern = /{([^{}]+)}/g;

  // We break tokenText into pieces that are either plain text or tokens,
  // then construct an array of functions to parse each piece
  var tokenFuncs = [];
  var charIndex  = 0;
  while (charIndex < tokenText.length) {
    // Find the next token
    let result = tokenPattern.exec(tokenText);

    if (!result) {
      // No tokens left. Parse the plain text after the last token
      let str = tokenText.substring(charIndex);
      tokenFuncs.push(props => str);
      break;
    } else if (result.index > charIndex) {
      // There is some plain text before the token
      let str = tokenText.substring(charIndex, result.index);
      tokenFuncs.push(props => str);
    }

    // Add a function to process the current token
    let token = result[1];
    tokenFuncs.push(props => props[token]);
    charIndex = tokenPattern.lastIndex;
  }
  
  // We now have an array of functions returning either a text string or
  // a feature property
  // Return a function that assembles everything
  return function(properties) {
    return tokenFuncs.reduce(concat, "");
    function concat(str, tokenFunc) {
      let text = tokenFunc(properties) || "";
      return str += text;
    }
  };
}

function getFontString(fontSize, fontFace) {
  // Round fontSize to the nearest 0.1 pixel
  fontSize = Math.round(10.0 * fontSize) * 0.1;

  // Get the last word of the first font string
  var lastWord;
  if (fontFace) lastWord = fontFace[0].split(" ").splice(-1)[0].toLowerCase();
  
  var fontStyle;
  switch (lastWord) {
    case "bold":
      fontStyle = "bold";
      break;
    case "italic":
      fontStyle = "italic";
      break;
  }

  return (fontStyle)
    ? fontStyle + " " + fontSize + 'px "PT Sans", sans-serif'
    : fontSize + 'px "PT Sans", sans-serif';
}

function getTextShift(anchor) {
  // We use the Canvas 2D settings 
  //  textBaseline = "bottom", textAlign = "left"
  // and shift the text box based on the specified "text-anchor"
  // Returned values will be scaled by the text box dimensions
  switch (anchor) {
    case "top-left":
      return [ 0.0, 1.0];
    case "top-right":
      return [-1.0, 1.0];
    case "top":
      return [-0.5, 1.0];
    case "bottom-left":
      return [ 0.0, 0.0];
    case "bottom-right":
      return [-1.0, 0.0];
    case "bottom":
      return [-0.5, 0.0];
    case "left":
      return [ 0.0, 0.5];
    case "right":
      return [-1.0, 0.5];
    case "center":
    default:
      return [-0.5, 0.5];
  }
}

function getTextTransform(code) {
  switch (code) {
    case "uppercase":
      return f => f.toUpperCase();
    case "lowercase":
      return f => f.toLowerCase();
    case "none":
    default:
      return f => f;
  }
}

function textSetup(style) {
  // Parse the style properties into zoom-dependent functions
  const getLayout = collectGetters(style.layout, [
    ["text-field"],
    ["text-size", 16],
    ["text-font"],
    ["text-line-height", 1.2],
    ["text-padding", 2.0],
    ["text-offset", [0, 0]],
    ["text-anchor"],
    ["text-transform", "none"],
  ]);

  const getPaint = collectGetters(style.paint, [
    ["text-color"],
    ["text-halo-color"],
    ["text-halo-width", 0],
  ]);

  return (ctx, zoom) => initTextLabeler(ctx, zoom, getLayout, getPaint);
}

function initTextLabeler(ctx, zoom, layout, paint) {
  const textParser = getTokenParser( layout["text-field"](zoom) );

  const fontSize = layout["text-size"](zoom);
  const fontFace = layout["text-font"](zoom);
  ctx.font = getFontString(fontSize, fontFace);

  const lineHeight = layout["text-line-height"](zoom);
  const textPadding = layout["text-padding"](zoom);
  const textOffset = layout["text-offset"](zoom);

  ctx.textBaseline = "bottom";
  ctx.textAlign = "left";
  const posShift = getTextShift( layout["text-anchor"](zoom) );

  const transform = getTextTransform( layout["text-transform"](zoom) );

  const haloWidth = paint["text-halo-width"](zoom);
  if (haloWidth > 0) {
    ctx.lineWidth = haloWidth * 2.0;
    ctx.lineJoin = "round";
    ctx.strokeStyle = paint["text-halo-color"](zoom);
  }
  ctx.fillStyle = paint["text-color"](zoom);

  var labelText, labelLength, labelHeight, x, y;

  return { measure, draw };

  function measure(feature) {
    labelText = textParser(feature.properties);
    if (!labelText) return;

    labelText = transform(labelText);
    labelLength = ctx.measureText(labelText).width;
    labelHeight = fontSize * lineHeight;

    var coords = feature.geometry.coordinates;
    // Compute coordinates of bottom left corner of text
    x = coords[0] + textOffset[0] * fontSize + posShift[0] * labelLength;
    y = coords[1] + textOffset[1] * labelHeight + posShift[1] * labelHeight;

    // Return a bounding box object
    return [
      [x - textPadding, y - labelHeight - textPadding],
      [x + labelLength + textPadding, y + textPadding]
    ];
  }

  function draw() {
    if (!labelText) return;

    if (haloWidth > 0) ctx.strokeText(labelText, x, y);
    ctx.fillText(labelText, x, y);
  }
}

function iconSetup(style, sprite) {
  const getLayout = collectGetters(style.layout, [
    ["icon-image"],
    ["icon-padding", 2],
  ]);

  return (ctx, zoom) => initIconLabeler(ctx, zoom, getLayout, sprite);
}

function initIconLabeler(ctx, zoom, layout, sprite) {
  const getSpriteID = getTokenParser( layout["icon-image"](zoom) );
  const iconPadding = layout["icon-padding"](zoom);

  var spriteID, spriteMeta, x, y;

  return { measure, draw };

  function measure(feature) {
    spriteID = getSpriteID(feature.properties);
    if (!spriteID) return;

    spriteMeta = sprite.meta[spriteID];

    var coords = feature.geometry.coordinates;
    x = Math.round(coords[0] - spriteMeta.width / 2);
    y = Math.round(coords[1] - spriteMeta.height / 2);

    return [
      [x - iconPadding, y - iconPadding],
      [x + spriteMeta.width + iconPadding, y + spriteMeta.height + iconPadding]
    ];
  } 

  function draw() {
    if (!spriteID) return;

    ctx.drawImage(
      sprite.image,
      spriteMeta.x,
      spriteMeta.y,
      spriteMeta.width,
      spriteMeta.height,
      x,
      y,
      spriteMeta.width,
      spriteMeta.height
    );
  }
}

function initLabeler(style, sprite) {
  // Skip unsupported symbol types
  if (style.layout["symbol-placement"] === "line") return () => undefined;

  const initTextLabeler = textSetup(style);
  const initIconLabeler = iconSetup(style, sprite);

  return function(ctx, zoom, data, boxes) {
    const textLabeler = initTextLabeler(ctx, zoom);
    const iconLabeler = initIconLabeler(ctx, zoom);

    data.features.forEach(drawLabel);

    function drawLabel(feature) {
      var textBox = textLabeler.measure(feature);
      if ( collides(textBox) ) return;

      var iconBox = iconLabeler.measure(feature);
      if ( collides(iconBox) ) return;

      if (textBox) boxes.push(textBox);
      if (iconBox) boxes.push(iconBox);

      // Draw the labels
      iconLabeler.draw();
      textLabeler.draw();
    }

    function collides(newBox) {
      if (!newBox) return false;
      return boxes.some( box => intersects(box, newBox) );
    }
  }
}

function intersects(box1, box2) {
  // box[0] = [xmin, ymin]; box[1] = [xmax, ymax]
  if (box1[0][0] > box2[1][0]) return false;
  if (box2[0][0] > box1[1][0]) return false;
  if (box1[0][1] > box2[1][1]) return false;
  if (box2[0][1] > box1[1][1]) return false;

  return true;
}

function buildFeatureFilter(filterObj) {
  // filterObj is a filter definition following the "deprecated" syntax:
  // https://docs.mapbox.com/mapbox-gl-js/style-spec/#other-filter
  if (!filterObj) return () => true;

  var type, key, vals;

  // If this is a combined filter, the vals are themselves filter definitions
  [type, ...vals] = filterObj;
  switch (type) {
    case "all": {
      let filters = vals.map(buildFeatureFilter);  // Iteratively recursive!
      return (d) => filters.every( filt => filt(d) );
    }
    case "any": {
      let filters = vals.map(buildFeatureFilter);
      return (d) => filters.some( filt => filt(d) );
    }
    case "none": {
      let filters = vals.map(buildFeatureFilter);
      return (d) => filters.every( filt => !filt(d) );
    }
  }

  [type, key, ...vals] = filterObj;
  var getVal = initFeatureValGetter(key);

  switch (type) {
    // Existential Filters
    case "has": 
      return d => !!getVal(d); // !! forces a Boolean return
    case "!has": 
      return d => !getVal(d);

    // Comparison Filters
    case "==": 
      return d => getVal(d) === vals[0];
    case "!=":
      return d => getVal(d) !== vals[0];
    case ">":
      return d => getVal(d) > vals[0];
    case ">=":
      return d => getVal(d) >= vals[0];
    case "<":
      return d => getVal(d) < vals[0];
    case "<=":
      return d => getVal(d) <= vals[0];

    // Set Membership Filters
    case "in" :
      return d => vals.includes( getVal(d) );
    case "!in" :
      return d => !vals.includes( getVal(d) );
    default:
      console.log("prepFilter: unknown filter type = " + filterObj[0]);
  }
  // No recognizable filter criteria. Return a filter that is always true
  return () => true;
}

function initFeatureValGetter(key) {
  switch (key) {
    case "$type":
      // NOTE: data includes MultiLineString, MultiPolygon, etc-NOT IN SPEC
      return f => {
        let t = f.geometry.type;
        if (t === "MultiPoint") return "Point";
        if (t === "MultiLineString") return "LineString";
        if (t === "MultiPolygon") return "Polygon";
        return t;
      };
    case "$id":
      return f => f.id;
    default:
      return f => f.properties[key];
  }
}

function initPainter(params) {
  const style = params.styleLayer;
  const sprite = params.spriteObject;
  const canvasSize = params.canvasSize || 512;

  // Define data prep and rendering functions
  var getData, render;
  switch (style.type) {
    case "background":
      getData = () => true;
      render = initBackgroundFill(style, canvasSize);
      break;
    case "raster":
      getData = makeSourceGetter(style);
      render = initRasterFill(style, canvasSize);
      break;
    case "symbol":
      getData = makeFeatureGetter(style);
      render = initLabeler(style, sprite);
      break;
    case "circle":
    case "line":
    case "fill":
      getData = makeFeatureGetter(style);
      render = initBrush(style);
      break;
    default:
      // Missing fill-extrusion, heatmap, hillshade
      return console.log("ERROR in initRenderer: layer.type = " +
        style.type + " not supported!");
  }

  // Compose into one function
  return function(context, zoom, sources, boundingBoxes) {
    // Quick exits if this layer is not meant to be displayed
    // TODO: this is keeping alive the link back to the style document?
    if (style.layout && style.layout["visibility"] === "none") return false;
    if (style.minzoom !== undefined && zoom < style.minzoom) return false;
    if (style.maxzoom !== undefined && zoom > style.maxzoom) return false;

    // Get the data for the layer
    const data = getData(sources);
    if (!data) return false;

    // Render
    render(context, zoom, data, boundingBoxes);

    // Restore Canvas state to starting point
    context.restore();
    // Save the starting point again (restore removed the saved copy)
    context.save();

    // Return flag to indicate the canvas has changed
    return true;
  }
}

function makeSourceGetter(style) {
  // Store the source name, so we don't re-access the style object every time
  const sourceName = style["source"];
  return (sources) => sources[sourceName];
}

function makeFeatureGetter(style) {
  const sourceName = style["source"];
  const layerName = style["source-layer"];
  const filter = buildFeatureFilter(style.filter);

  return function(sources) {
    let source = sources[sourceName];
    if (!source) return false;

    let layer = source[layerName];
    if (!layer) return false;

    let features = layer.features.filter(filter);
    if (features.length < 1) return false;

    return { type: "FeatureCollection", features: features };
  }
}

function loadStyle(style, mbToken, canvasSize, callback) {

  // Get a Promise that resolves to a Mapbox style document
  const getStyleJson = (typeof style === "object")
    ? Promise.resolve(style)                // style is JSON already
    : getJSON( expandStyleURL(style, mbToken) ); // Get from URL


  // Now set up a Promise chain to process the document
  return getStyleJson
    .then( expandLayerReferences )

    .then( retrieveSourceInfo )

    .then( addPainterFunctions )

    .then(finalStyle => callback(null, finalStyle))
    .catch(err => callback(err));


  function retrieveSourceInfo(styleDoc) {
    const getSprite = loadSprite(styleDoc, mbToken);

    const expandSources = Object.keys(styleDoc.sources)
      .map(key => expandSource(key, styleDoc.sources, mbToken));

    return Promise.all([...expandSources, getSprite])
      .then(() => styleDoc);
  }

  function addPainterFunctions(styleDoc) {
    styleDoc.layers.forEach(layer => {
      layer.painter = initPainter({
        canvasSize: canvasSize,
        styleLayer: layer,
        spriteObject: styleDoc.spriteData,
      });
    });

    return styleDoc;
  }
}

function loadSprite(styleDoc, token) {
  if (!styleDoc.sprite) return;

  const urls = expandSpriteURLs(styleDoc.sprite, token);

  return Promise.all([getImage(urls.image), getJSON(urls.meta)])
    .then(([image, meta]) => { styleDoc.spriteData = { image, meta }; });
}

function expandSource(key, sources, token) {
  var source = sources[key];
  if (source.url === undefined) return; // No change

  // Load the referenced TileJSON document
  return getJSON( expandTileURL(source.url, token) )
    .then(json => merge(json));

  function merge(json) {
    // Add any custom properties from the style document
    Object.keys(source).forEach( k2 => { json[k2] = source[k2]; } );
    // Replace current entry with the TileJSON data
    sources[key] = json;
  }
}

function initGroups(styleDoc) {
  // Filter to confirm an array element is not equal to the previous element
  const uniq = (x, i, a) => ( !i || x !== a[i-1] );

  const groupNames = styleDoc.layers
    .map( layer => layer["tilekiln-group"] || "none" )
    .filter(uniq);

  // Make sure the groups are in order, not interleaved
  const groupCheck = groupNames.slice().sort().filter(uniq);
  if (groupCheck.length !== groupNames.length) {
    // TODO: assumes we are calling from a Promise chain?
    throw Error("tile-kiln setup: Input layer groups are not in order!");
  }

  // For each group name, collect the layers from the style document, and
  // add a visibility property
  const groups = groupNames.map( name => {
    return {
      name,
      visible: true,
      layers: sortStyleGroup(styleDoc.layers, name),
    };
  });

  return groups;
}

function sortStyleGroup(layers, groupName) {
  // Get the layers belonging to this group
  var group = (groupName !== "none")
    ? layers.filter(layer => layer["tilekiln-group"] === groupName)
    : layers.filter(layer => !layer["tilekiln-group"]);

  // Reverse the order of the symbol layers
  var labels = group.filter(layer => layer.type === "symbol").reverse();

  // Append reordered symbol layers to non-symbol layers
  return group.filter(layer => layer.type !== "symbol").concat(labels);
}

var utf8TextDecoder = typeof TextDecoder === 'undefined' ? null : new TextDecoder('utf8');

function loadImage(href, callback) {
  const img = new Image();
  img.onerror = () => callback("ERROR in loadImage for href " + href);
  img.onload = checkImg;
  img.crossOrigin = "anonymous";
  img.src = href;

  function checkImg() {
    if (img.complete && img.naturalWidth !== 0) {
      return callback(null, img);
    } else {
      return callback("ERROR in loadImage for href " + href);
    }
  }

  return img;
}

function initTileFactory(size, sources, styleGroups, loader) {
  // Input size is the pixel size of the canvas used for vector rendering
  // Input sources is an OBJECT of TileJSON descriptions of tilesets
  // Input styleGroups is an ARRAY of objects { name, visible } for groupings of
  // style layers that will be rendered to separate canvases before compositing

  // For now we ignore sources that don't have tile endpoints
  const tileSourceKeys = Object.keys(sources).filter( k => {
    return sources[k].tiles && sources[k].tiles.length > 0;
  });

  function orderTile(z, x, y, callback = () => true) {
    const loadTasks = {};
    var numToDo = tileSourceKeys.length;
    var baseLamina = initLamina(size);

    const tile = {
      z, x, y,
      id: z + "/" + x + "/" + y,
      priority: 0,

      sources: {},
      laminae: {},
      img: baseLamina.img,
      ctx: baseLamina.ctx,

      loaded: false,
      cancel,
      canceled: false,
      rendering: baseLamina.rendering,
      rendered: baseLamina.rendered,
    };

    // Add canvases for separate rendering of layer groups, if supplied
    if (styleGroups && styleGroups.length > 1) {
      styleGroups.forEach( group => {
        tile.laminae[group.name] = initLamina(size);
      });
    }

    tileSourceKeys.forEach( loadTile );

    function loadTile(srcKey) {
      var src = sources[srcKey];
      var tileHref = tileURL(src.tiles[0], z, x, y);
      if (src.type === "vector") {
        //readMVT( tileHref, size, (err, data) => checkData(err, srcKey, data) );
        let readCallback = (err, data) => checkData(err, srcKey, data);
        let readPayload = { href: tileHref, size: size };
        loadTasks[srcKey] = loader.startTask(readPayload, readCallback);
      } else if (src.type === "raster") {
        loadImage( tileHref, (err, data) => checkData(err, srcKey, data) );
      }
    }

    function cancel() {
      Object.values(loadTasks).forEach(task => loader.cancelTask(task));
      tile.canceled = true;
    }

    function checkData(err, key, data) {
      // If data retrieval errors, don't stop. We could be out of the range of
      // one layer, but we may still be able to render the other layers
      if (err) console.log(err);
      // TODO: maybe stop if all layers have errors?

      tile.sources[key] = data;
      delete loadTasks[key];
      if (--numToDo > 0) return;

      tile.loaded = true;
      return callback(null, tile);
    }
    return tile;
  }

  return orderTile;
}

function initLamina(size) {
  let img = document.createElement("canvas");
  img.width = size;
  img.height = size;
  let ctx = img.getContext("2d");
  ctx.save(); // Save default styles
  return { img, ctx, rendering: false, rendered: false };
}

function tileURL(endpoint, z, x, y) {
  return endpoint.replace(/{z}/, z).replace(/{x}/, x).replace(/{y}/, y);
}

function initRenderer(canvSize, styleGroups, chains) {
  // Input canvSize is an integer, for the pixel size of the (square) tiles

  var getLamina, composite;
  if (styleGroups.length > 1) { 
    // Define function to return the appropriate lamina (partial rendering)
    getLamina = (tile, groupName) => tile.laminae[groupName];
    // Define function to composite all laminae canvases into the main canvas
    composite = (tile) => {
      tile.ctx.clearRect(0, 0, canvSize, canvSize);
      styleGroups.forEach( group => {
        if (!group.visible) return;
        tile.ctx.drawImage(tile.laminae[group.name].img, 0, 0);
      });
    };
  } else {
    // Only one group of style layers. Render directly to the main canvas
    getLamina = (tile, groupName) => tile;
    // Compositing is not needed: return a dummy no-op function
    composite = (tile) => true;
  }

  return {
    drawGroup,
    composite,
  };

  function drawGroup(tile, layerGroup, callback = () => undefined) {
    let lamina = getLamina(tile, layerGroup.name);
    if (lamina.rendered) return callback(null, tile);

    lamina.ctx.clearRect(0, 0, canvSize, canvSize);
    const boundingBoxes = [];

    // Draw the layers: asynchronously, but in order
    // Create a chain of functions, one for each layer.
    const drawCalls = layerGroup.layers.map(layer => {
      return () => layer.painter(lamina.ctx, tile.z, tile.sources, boundingBoxes);
    });
    // Execute the chain, with copyResult as the final callback
    chains.chainSyncList(drawCalls, returnResult, tile.id);

    function returnResult() {
      lamina.rendered = true;
      return callback(null, tile);
    }
  }
}

function init(params) {
  // Process parameters, substituting defaults as needed
  var canvSize = params.size || 512;
  var styleURL = params.style;   // REQUIRED
  var mbToken  = params.token;   // May be undefined
  var callback = params.callback || ( () => undefined );

  // Declare some variables & methods that will be defined inside a callback
  var tileFactory, renderer, t0, t1, t2;
  var styleGroups = [];
  var activeDrawCalls = 0;

  function setGroupVisibility(name, visibility) {
    var group = styleGroups.find(group => group.name === name);
    if (group) group.visible = visibility;
  }

  // Initialize a worker thread to read and parse MVT tiles
  const readThread = initWorker("./worker.bundle.js");

  // Initialize handler for chaining functions asynchronously
  const chains = initChainer();

  const api = { // Initialize properties, update when styles load
    style: {},    // WARNING: directly modifiable from calling program

    create: () => undefined,
    hideGroup: (name) => setGroupVisibility(name, false),
    showGroup: (name) => setGroupVisibility(name, true),
    redraw: () => undefined,
    activeDrawCalls: () => activeDrawCalls,
    sortTasks: chains.sortTasks,

    ready: false,
  };

  // Get the style info
  loadStyle(styleURL, mbToken, canvSize, setup);

  return api;

  function setup(err, styleDoc) {
    if (err) callback(err);

    styleGroups = initGroups(styleDoc);

    tileFactory = initTileFactory(canvSize, styleDoc.sources, 
      styleGroups, readThread);
    renderer = initRenderer(canvSize, styleGroups, chains);

    // Update api
    // TODO: we could initialize renderer without styles, then send it the
    // styles when ready. This could avoid the need to rewrite the API.
    api.style = styleDoc;
    api.create = create;

    api.redraw = drawAll;
    api.ready = true;

    return callback(null, api);
  }

  function create(z, x, y, cb = () => undefined, reportTime) {
    if (reportTime) t0 = performance.now();
    var tile = tileFactory(z, x, y, render);
    function render(err) {
      if (err) cb(err);
      if (reportTime) {
        t1 = performance.now();
        cb("Calling drawAll");
      }
      drawAll(tile, cb, reportTime);
    }
    return tile;
  }

  function drawAll(tile, callback = () => true, reportTime) {
    // If tile has been canceled, exit without even executing the callback
    if (tile.canceled) return;

    if (!tile.loaded) return; // Data not ready
    if (tile.rendering || tile.rendered) return; // Duplicate call?

    // Flag this tile as in the process of rendering
    tile.rendering = true;
    activeDrawCalls ++;

    //var numToDo = styleGroups.length;
    //styleGroups.forEach(group => {
    //  if (!group.visible) return;
    //  let cb = (err, tile) => checkAll(err, tile, group.name);
    //  renderer.drawGroup(tile, group.name, cb);
    //});

    // Make a chain of functions to draw each group
    const drawCalls = styleGroups.filter(grp => grp.visible).map(makeDrawCall);

    function makeDrawCall(group) {
      // Wrap a drawGroup call to make a function taking only a callback
      // as an argument
      return (cb) => {
        // Modify the callback to check the tile first
        let checkCb = (err, tile) => {
          check(err, tile, group.name);
          cb();
        };
        renderer.drawGroup(tile, group, checkCb);
      };
    }

    // Execute the chain, with putTogether as the final callback
    chains.chainAsyncList(drawCalls, putTogether, tile.id);

    function putTogether() {
      renderer.composite(tile);

      tile.rendered = true;
      tile.rendering = false;
      activeDrawCalls --;

      if (!reportTime) return callback(null, tile);
      t2 = performance.now();
      return callback(null, tile, t2 - t1, t1 - t0);
    }

    function check(err, tile, groupName) {
      if (err) return callback(err);
      if (reportTime) {
        let dt = (performance.now() - t0).toFixed(1);
        callback("check: " + groupName + ", dt = " + dt + "ms");
      }
    }
  }
}

export { init };
