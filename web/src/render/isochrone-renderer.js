import {
  CYCLE_COLOUR_MAP_GLSL,
  DEFAULT_COLOUR_CYCLE_MINUTES,
  EDGE_INTERPOLATION_SLACK_SECONDS,
} from '../config/constants.js';
import { normalizeIsochroneTheme } from './colour.js';
import { resolveViewportFrame } from '../core/viewport.js';
import { clampInt } from '../core/math.js';
import {
  syncCanvasToDisplaySize,
  validatePixelGrid,
  validateTravelTimeGrid,
} from './pixel-grid.js';

// The isochrone canvas renderers. createIsochroneRenderer picks the WebGL
// implementation when a context is available and silently falls back to the
// 2D canvas one, so callers only deal with the shared method set (draw /
// drawTravelTimeGrid / drawTravelTimeEdges / drawTravelTimeEdgesFromNodeTimes),
// each guarded by a `typeof` check at the call site.

// How a Float32Array of edge vertices is packed. The two WebGL edge programs
// share a single vertex buffer, so whatever is resident in it has to be
// labelled with the layout that wrote it.
export const EDGE_VERTEX_LAYOUT_PLAIN = 'plain';
export const EDGE_VERTEX_LAYOUT_NODE_INDEXED = 'node-indexed';

export function getIsochroneThemeVariant(theme) {
  return normalizeIsochroneTheme(theme, 'dark') === 'light' ? 1 : 0;
}

export function createCanvas2dIsochroneRenderer(canvas) {
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Unable to get 2D context for isochrone canvas');
  }
  const scratchCanvas =
    globalThis.document && typeof globalThis.document.createElement === 'function'
      ? globalThis.document.createElement('canvas')
      : null;
  const scratchContext = scratchCanvas?.getContext?.('2d') ?? null;

  return {
    mode: '2d',
    clear(options = {}) {
      syncCanvasToDisplaySize(canvas);
      const targetWidthPx = options.widthPx ?? canvas.width;
      const targetHeightPx = options.heightPx ?? canvas.height;
      if (!Number.isFinite(targetWidthPx) || targetWidthPx <= 0) {
        throw new Error('options.widthPx (or canvas.width) must be positive');
      }
      if (!Number.isFinite(targetHeightPx) || targetHeightPx <= 0) {
        throw new Error('options.heightPx (or canvas.height) must be positive');
      }

      const widthPx = Math.floor(targetWidthPx);
      const heightPx = Math.floor(targetHeightPx);
      if (canvas.width !== widthPx) {
        canvas.width = widthPx;
      }
      if (canvas.height !== heightPx) {
        canvas.height = heightPx;
      }
      context.clearRect(0, 0, canvas.width, canvas.height);
    },
    draw(pixelGrid, options = {}) {
      if (!syncCanvasToDisplaySize(canvas) && (!(canvas.width > 0) || !(canvas.height > 0))) {
        canvas.width = pixelGrid.widthPx;
        canvas.height = pixelGrid.heightPx;
      }

      const imageData = new ImageData(pixelGrid.rgba, pixelGrid.widthPx, pixelGrid.heightPx);
      context.clearRect(0, 0, canvas.width, canvas.height);
      const viewportFrame = resolveViewportFrame(
        { gridWidthPx: pixelGrid.widthPx, gridHeightPx: pixelGrid.heightPx },
        options.viewport,
        {
          frameWidthPx: canvas.width,
          frameHeightPx: canvas.height,
          fitBoundingBoxPx: options.fitBoundingBoxPx,
        },
      );
      if (
        scratchCanvas
        && scratchContext
        && (
          viewportFrame.effectiveScale !== 1
          || viewportFrame.offsetXPx !== 0
          || viewportFrame.offsetYPx !== 0
          || canvas.width !== pixelGrid.widthPx
          || canvas.height !== pixelGrid.heightPx
        )
      ) {
        scratchCanvas.width = pixelGrid.widthPx;
        scratchCanvas.height = pixelGrid.heightPx;
        scratchContext.putImageData(imageData, 0, 0);
        context.imageSmoothingEnabled = false;
        context.drawImage(
          scratchCanvas,
          viewportFrame.offsetXPx,
          viewportFrame.offsetYPx,
          viewportFrame.visibleWidthPx,
          viewportFrame.visibleHeightPx,
          0,
          0,
          canvas.width,
          canvas.height,
        );
      } else {
        context.putImageData(imageData, 0, 0);
      }
      return imageData;
    },
  };
}

export function shouldUploadEdgeGeometry(
  previousEdgeVertexDataRef,
  previousEdgeVertexDataLength,
  edgeVertexData,
  options = {},
) {
  if (!(edgeVertexData instanceof Float32Array)) {
    throw new Error('edgeVertexData must be a Float32Array');
  }
  const append = options.append === true;
  const reuseUploadedGeometry = options.reuseUploadedGeometry === true;
  if (append || !reuseUploadedGeometry) {
    return true;
  }
  // The plain and node-indexed edge programs share one GL vertex buffer but
  // pack it differently (6 floats per edge vs 12). Matching on the array
  // identity alone would let a node-indexed draw reuse bytes a plain draw
  // uploaded, reinterpreting them under the wrong stride.
  if ((options.previousLayout ?? null) !== (options.layout ?? null)) {
    return true;
  }
  if (previousEdgeVertexDataRef !== edgeVertexData) {
    return true;
  }
  return previousEdgeVertexDataLength !== edgeVertexData.length;
}

export function computeNodeTimeTextureDimensions(nodeCount, maxTextureSize) {
  if (!Number.isInteger(nodeCount) || nodeCount <= 0) {
    throw new Error('nodeCount must be a positive integer');
  }
  if (!Number.isInteger(maxTextureSize) || maxTextureSize <= 0) {
    throw new Error('maxTextureSize must be a positive integer');
  }
  const width = Math.min(maxTextureSize, nodeCount);
  const height = Math.ceil(nodeCount / width);
  if (height > maxTextureSize) {
    throw new Error('nodeCount exceeds representable node-time texture capacity');
  }
  return { width, height, size: width * height };
}

export function createWebGlShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error('failed to allocate WebGL shader');
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const infoLog = gl.getShaderInfoLog(shader) ?? 'unknown shader compile error';
    gl.deleteShader(shader);
    throw new Error(`WebGL shader compile failed: ${infoLog}`);
  }
  return shader;
}

export function createWebGlProgram(gl, vertexShaderSource, fragmentShaderSource) {
  const vertexShader = createWebGlShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
  const fragmentShader = createWebGlShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    throw new Error('failed to allocate WebGL program');
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const infoLog = gl.getProgramInfoLog(program) ?? 'unknown program link error';
    gl.deleteProgram(program);
    throw new Error(`WebGL program link failed: ${infoLog}`);
  }

  return program;
}

export function createWebGlIsochroneRenderer(canvas, options = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') {
    throw new Error('canvas must provide getContext("webgl")');
  }

  const contextAttributes = {
    alpha: true,
    antialias: true,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    ...options.contextAttributes,
  };
  const contextWebGl2 = canvas.getContext('webgl2', contextAttributes);
  const contextWebGl = canvas.getContext('webgl', contextAttributes);
  const gl = contextWebGl2 ?? contextWebGl;
  if (!gl) {
    return null;
  }

  const isWebGl2 =
    typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
  const vertexShaderSource = isWebGl2
    ? `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main(void) {
  v_uv = (a_position + 1.0) * 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`
    : `attribute vec2 a_position;
varying vec2 v_uv;
void main(void) {
  v_uv = (a_position + 1.0) * 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;
  const fragmentShaderSource = isWebGl2
    ? `#version 300 es
precision mediump float;
uniform sampler2D u_texture;
uniform vec2 u_texture_size_px;
uniform vec2 u_viewport_px;
uniform vec2 u_view_offset_px;
uniform float u_view_scale;
in vec2 v_uv;
out vec4 outColor;
void main(void) {
  vec2 screenPx = vec2(v_uv.x * u_viewport_px.x, (1.0 - v_uv.y) * u_viewport_px.y);
  vec2 samplePx = u_view_offset_px + screenPx / max(u_view_scale, 1.0);
  vec2 sampleUv = samplePx / u_texture_size_px;
  if (sampleUv.x < 0.0 || sampleUv.y < 0.0 || sampleUv.x > 1.0 || sampleUv.y > 1.0) {
    outColor = vec4(0.0, 0.0, 0.0, 0.0);
    return;
  }
  outColor = texture(u_texture, sampleUv);
}`
    : `precision mediump float;
uniform sampler2D u_texture;
uniform vec2 u_texture_size_px;
uniform vec2 u_viewport_px;
uniform vec2 u_view_offset_px;
uniform float u_view_scale;
varying vec2 v_uv;
void main(void) {
  vec2 screenPx = vec2(v_uv.x * u_viewport_px.x, (1.0 - v_uv.y) * u_viewport_px.y);
  vec2 samplePx = u_view_offset_px + screenPx / max(u_view_scale, 1.0);
  vec2 sampleUv = samplePx / u_texture_size_px;
  if (sampleUv.x < 0.0 || sampleUv.y < 0.0 || sampleUv.x > 1.0 || sampleUv.y > 1.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
    return;
  }
  gl_FragColor = texture2D(u_texture, sampleUv);
}`;

  const program = createWebGlProgram(gl, vertexShaderSource, fragmentShaderSource);
  const positionLocation = gl.getAttribLocation(program, 'a_position');
  if (positionLocation < 0) {
    gl.deleteProgram(program);
    throw new Error('WebGL program is missing a_position attribute');
  }

  const quadBuffer = gl.createBuffer();
  if (!quadBuffer) {
    gl.deleteProgram(program);
    throw new Error('failed to allocate WebGL quad buffer');
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

  const texture = gl.createTexture();
  if (!texture) {
    gl.deleteBuffer(quadBuffer);
    gl.deleteProgram(program);
    throw new Error('failed to allocate WebGL texture');
  }
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  const textureLocation = gl.getUniformLocation(program, 'u_texture');
  const textureSizeLocation = gl.getUniformLocation(program, 'u_texture_size_px');
  const viewportSizeLocation = gl.getUniformLocation(program, 'u_viewport_px');
  const textureViewOffsetLocation = gl.getUniformLocation(program, 'u_view_offset_px');
  const textureViewScaleLocation = gl.getUniformLocation(program, 'u_view_scale');
  const bindQuadToProgram = (programToBind, positionLocationToBind) => {
    gl.useProgram(programToBind);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.enableVertexAttribArray(positionLocationToBind);
    gl.vertexAttribPointer(positionLocationToBind, 2, gl.FLOAT, false, 0, 0);
  };

  let travelTimeProgram = null;
  let travelTimePositionLocation = -1;
  let travelTimeTexture = null;
  let travelTimeTextureLocation = null;
  let travelTimeCycleMinutesLocation = null;
  let travelTimeThemeVariantLocation = null;
  let travelTimeTextureSizeLocation = null;
  let travelTimeViewportSizeLocation = null;
  let travelTimeViewOffsetLocation = null;
  let travelTimeViewScaleLocation = null;

  if (isWebGl2) {
    const travelTimeFragmentSource = `#version 300 es
precision highp float;
uniform sampler2D u_time_texture;
uniform float u_cycle_minutes;
uniform float u_theme_variant;
uniform vec2 u_texture_size_px;
uniform vec2 u_viewport_px;
uniform vec2 u_view_offset_px;
uniform float u_view_scale;
in vec2 v_uv;
out vec4 outColor;

${CYCLE_COLOUR_MAP_GLSL}

void main(void) {
  vec2 screenPx = vec2(v_uv.x * u_viewport_px.x, (1.0 - v_uv.y) * u_viewport_px.y);
  vec2 samplePx = u_view_offset_px + screenPx / max(u_view_scale, 1.0);
  vec2 sampleUv = samplePx / u_texture_size_px;
  if (sampleUv.x < 0.0 || sampleUv.y < 0.0 || sampleUv.x > 1.0 || sampleUv.y > 1.0) {
    outColor = vec4(0.0, 0.0, 0.0, 0.0);
    return;
  }
  float seconds = texture(u_time_texture, sampleUv).r;
  if (seconds < 0.0) {
    outColor = vec4(0.0, 0.0, 0.0, 0.0);
    return;
  }
  float cycleMinutes = max(u_cycle_minutes, 1.0);
  float cyclePositionMinutes = mod(seconds / 60.0, cycleMinutes);
  float cycleRatio = cyclePositionMinutes / cycleMinutes;
  vec3 rgb = mapCycleColour(cycleRatio, u_theme_variant) / 255.0;
  outColor = vec4(rgb, 1.0);
}`;

    travelTimeProgram = createWebGlProgram(gl, vertexShaderSource, travelTimeFragmentSource);
    travelTimePositionLocation = gl.getAttribLocation(travelTimeProgram, 'a_position');
    if (travelTimePositionLocation < 0) {
      gl.deleteProgram(travelTimeProgram);
      travelTimeProgram = null;
    } else {
      travelTimeTexture = gl.createTexture();
      if (!travelTimeTexture) {
        gl.deleteProgram(travelTimeProgram);
        travelTimeProgram = null;
      } else {
        gl.bindTexture(gl.TEXTURE_2D, travelTimeTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        travelTimeTextureLocation = gl.getUniformLocation(travelTimeProgram, 'u_time_texture');
        travelTimeCycleMinutesLocation = gl.getUniformLocation(travelTimeProgram, 'u_cycle_minutes');
        travelTimeThemeVariantLocation = gl.getUniformLocation(travelTimeProgram, 'u_theme_variant');
        travelTimeTextureSizeLocation = gl.getUniformLocation(travelTimeProgram, 'u_texture_size_px');
        travelTimeViewportSizeLocation = gl.getUniformLocation(travelTimeProgram, 'u_viewport_px');
        travelTimeViewOffsetLocation = gl.getUniformLocation(travelTimeProgram, 'u_view_offset_px');
        travelTimeViewScaleLocation = gl.getUniformLocation(travelTimeProgram, 'u_view_scale');
      }
    }
  }

  const edgeVertexShaderSource = isWebGl2
    ? `#version 300 es
in vec2 a_position_px;
in float a_seconds;
uniform vec2 u_viewport_px;
uniform vec2 u_view_offset_px;
uniform float u_view_scale;
out float v_seconds;
void main(void) {
  vec2 viewPositionPx = (a_position_px - u_view_offset_px) * u_view_scale;
  vec2 clip = vec2(
    (viewPositionPx.x / u_viewport_px.x) * 2.0 - 1.0,
    1.0 - (viewPositionPx.y / u_viewport_px.y) * 2.0
  );
  v_seconds = a_seconds;
  gl_Position = vec4(clip, 0.0, 1.0);
}`
    : `attribute vec2 a_position_px;
attribute float a_seconds;
uniform vec2 u_viewport_px;
uniform vec2 u_view_offset_px;
uniform float u_view_scale;
varying float v_seconds;
void main(void) {
  vec2 viewPositionPx = (a_position_px - u_view_offset_px) * u_view_scale;
  vec2 clip = vec2(
    (viewPositionPx.x / u_viewport_px.x) * 2.0 - 1.0,
    1.0 - (viewPositionPx.y / u_viewport_px.y) * 2.0
  );
  v_seconds = a_seconds;
  gl_Position = vec4(clip, 0.0, 1.0);
}`;
  const edgeFragmentShaderSource = isWebGl2
    ? `#version 300 es
precision highp float;
uniform float u_cycle_minutes;
uniform float u_alpha;
uniform float u_theme_variant;
in float v_seconds;
out vec4 outColor;

${CYCLE_COLOUR_MAP_GLSL}

void main(void) {
  if (v_seconds < 0.0) {
    outColor = vec4(0.0, 0.0, 0.0, 0.0);
    return;
  }
  float cycleMinutes = max(u_cycle_minutes, 1.0);
  float cyclePositionMinutes = mod(v_seconds / 60.0, cycleMinutes);
  float cycleRatio = cyclePositionMinutes / cycleMinutes;
  vec3 rgb = mapCycleColour(cycleRatio, u_theme_variant) / 255.0;
  outColor = vec4(rgb, u_alpha);
}`
    : `precision highp float;
uniform float u_cycle_minutes;
uniform float u_alpha;
uniform float u_theme_variant;
varying float v_seconds;

${CYCLE_COLOUR_MAP_GLSL}

void main(void) {
  if (v_seconds < 0.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
    return;
  }
  float cycleMinutes = max(u_cycle_minutes, 1.0);
  float cyclePositionMinutes = mod(v_seconds / 60.0, cycleMinutes);
  float cycleRatio = cyclePositionMinutes / cycleMinutes;
  vec3 rgb = mapCycleColour(cycleRatio, u_theme_variant) / 255.0;
  gl_FragColor = vec4(rgb, u_alpha);
}`;
  const edgeProgram = createWebGlProgram(gl, edgeVertexShaderSource, edgeFragmentShaderSource);
  const edgePositionLocation = gl.getAttribLocation(edgeProgram, 'a_position_px');
  const edgeSecondsLocation = gl.getAttribLocation(edgeProgram, 'a_seconds');
  if (edgePositionLocation < 0 || edgeSecondsLocation < 0) {
    gl.deleteProgram(edgeProgram);
    throw new Error('WebGL edge program is missing required attributes');
  }
  const edgeViewportLocation = gl.getUniformLocation(edgeProgram, 'u_viewport_px');
  const edgeViewOffsetLocation = gl.getUniformLocation(edgeProgram, 'u_view_offset_px');
  const edgeViewScaleLocation = gl.getUniformLocation(edgeProgram, 'u_view_scale');
  const edgeCycleMinutesLocation = gl.getUniformLocation(edgeProgram, 'u_cycle_minutes');
  const edgeAlphaLocation = gl.getUniformLocation(edgeProgram, 'u_alpha');
  const edgeThemeVariantLocation = gl.getUniformLocation(edgeProgram, 'u_theme_variant');
  const edgeVertexBuffer = gl.createBuffer();
  if (!edgeVertexBuffer) {
    gl.deleteProgram(edgeProgram);
    throw new Error('failed to allocate WebGL edge vertex buffer');
  }
  let edgeVertexBufferCapacityFloats = 0;
  // Single record of what edgeVertexBuffer currently holds. Both edge programs
  // draw from this one buffer, so tracking them separately would let each one
  // believe its own geometry was still resident after the other overwrote it.
  let lastUploadedEdgeVertexDataRef = null;
  let lastUploadedEdgeVertexDataLength = 0;
  let lastUploadedEdgeVertexDataLayout = null;
  const forgetUploadedEdgeGeometry = () => {
    lastUploadedEdgeVertexDataRef = null;
    lastUploadedEdgeVertexDataLength = 0;
    lastUploadedEdgeVertexDataLayout = null;
  };
  const rememberUploadedEdgeGeometry = (edgeVertexData, layout) => {
    lastUploadedEdgeVertexDataRef = edgeVertexData;
    lastUploadedEdgeVertexDataLength = edgeVertexData.length;
    lastUploadedEdgeVertexDataLayout = layout;
  };
  const ensureEdgeVertexBufferCapacity = (requiredFloats) => {
    if (!Number.isInteger(requiredFloats) || requiredFloats <= 0) {
      throw new Error('requiredFloats must be a positive integer');
    }
    if (edgeVertexBufferCapacityFloats >= requiredFloats) {
      return;
    }
    let nextCapacityFloats = Math.max(1024, edgeVertexBufferCapacityFloats || 1024);
    while (nextCapacityFloats < requiredFloats) {
      nextCapacityFloats *= 2;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, edgeVertexBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      nextCapacityFloats * Float32Array.BYTES_PER_ELEMENT,
      gl.DYNAMIC_DRAW,
    );
    edgeVertexBufferCapacityFloats = nextCapacityFloats;
  };

  let indexedEdgeProgram = null;
  let indexedEdgePositionLocation = -1;
  let indexedEdgeSourceNodeLocation = -1;
  let indexedEdgeTargetNodeLocation = -1;
  let indexedEdgeCostLocation = -1;
  let indexedEdgeEndpointLocation = -1;
  let indexedEdgeViewportLocation = null;
  let indexedEdgeViewOffsetLocation = null;
  let indexedEdgeViewScaleLocation = null;
  let indexedEdgeCycleMinutesLocation = null;
  let indexedEdgeAlphaLocation = null;
  let indexedEdgeThemeVariantLocation = null;
  let indexedEdgeSlackSecondsLocation = null;
  let indexedEdgeNodeTimeTextureLocation = null;
  let indexedEdgeNodeTimeTextureSizeLocation = null;
  let indexedEdgeNodeTimeTexture = null;
  let indexedEdgeNodeTimeTextureWidth = 0;
  let indexedEdgeNodeTimeTextureHeight = 0;
  let indexedEdgeNodeTimeTextureUploadBuffer = null;
  let indexedEdgeNodeTimeTextureFloat64Bridge = null;
  let indexedEdgeMaxTextureSize = 0;

  if (isWebGl2) {
    const indexedEdgeVertexShaderSource = `#version 300 es
precision highp float;
in vec2 a_position_px;
in float a_source_node_index;
in float a_target_node_index;
in float a_edge_cost_seconds;
in float a_endpoint_t;
uniform vec2 u_viewport_px;
uniform vec2 u_view_offset_px;
uniform float u_view_scale;
uniform sampler2D u_node_time_texture;
uniform ivec2 u_node_time_texture_size;
uniform float u_edge_slack_seconds;
out float v_seconds;
out float v_visible;

float readNodeSeconds(float nodeIndexFloat) {
  int nodeIndex = int(nodeIndexFloat + 0.5);
  int textureWidth = u_node_time_texture_size.x;
  int x = nodeIndex % textureWidth;
  int y = nodeIndex / textureWidth;
  return texelFetch(u_node_time_texture, ivec2(x, y), 0).r;
}

bool isFiniteSeconds(float value) {
  return !(isnan(value) || isinf(value));
}

void main(void) {
  vec2 viewPositionPx = (a_position_px - u_view_offset_px) * u_view_scale;
  vec2 clip = vec2(
    (viewPositionPx.x / u_viewport_px.x) * 2.0 - 1.0,
    1.0 - (viewPositionPx.y / u_viewport_px.y) * 2.0
  );
  gl_Position = vec4(clip, 0.0, 1.0);

  float startSeconds = readNodeSeconds(a_source_node_index);
  float targetSeconds = readNodeSeconds(a_target_node_index);
  float expectedTargetSeconds = startSeconds + a_edge_cost_seconds;
  bool visible = isFiniteSeconds(startSeconds)
    && isFiniteSeconds(targetSeconds)
    && isFiniteSeconds(a_edge_cost_seconds)
    && a_edge_cost_seconds > 0.0
    && expectedTargetSeconds <= targetSeconds + u_edge_slack_seconds;
  v_visible = visible ? 1.0 : 0.0;
  if (!visible) {
    v_seconds = -1.0;
    return;
  }
  v_seconds = mix(startSeconds, expectedTargetSeconds, a_endpoint_t);
}`;
    const indexedEdgeFragmentShaderSource = `#version 300 es
precision highp float;
uniform float u_cycle_minutes;
uniform float u_alpha;
uniform float u_theme_variant;
in float v_seconds;
in float v_visible;
out vec4 outColor;

${CYCLE_COLOUR_MAP_GLSL}

void main(void) {
  if (v_visible < 0.5 || v_seconds < 0.0) {
    outColor = vec4(0.0, 0.0, 0.0, 0.0);
    return;
  }
  float cycleMinutes = max(u_cycle_minutes, 1.0);
  float cyclePositionMinutes = mod(v_seconds / 60.0, cycleMinutes);
  float cycleRatio = cyclePositionMinutes / cycleMinutes;
  vec3 rgb = mapCycleColour(cycleRatio, u_theme_variant) / 255.0;
  outColor = vec4(rgb, u_alpha);
}`;
    try {
      indexedEdgeProgram = createWebGlProgram(
        gl,
        indexedEdgeVertexShaderSource,
        indexedEdgeFragmentShaderSource,
      );
      indexedEdgePositionLocation = gl.getAttribLocation(indexedEdgeProgram, 'a_position_px');
      indexedEdgeSourceNodeLocation = gl.getAttribLocation(indexedEdgeProgram, 'a_source_node_index');
      indexedEdgeTargetNodeLocation = gl.getAttribLocation(indexedEdgeProgram, 'a_target_node_index');
      indexedEdgeCostLocation = gl.getAttribLocation(indexedEdgeProgram, 'a_edge_cost_seconds');
      indexedEdgeEndpointLocation = gl.getAttribLocation(indexedEdgeProgram, 'a_endpoint_t');
      if (
        indexedEdgePositionLocation < 0
        || indexedEdgeSourceNodeLocation < 0
        || indexedEdgeTargetNodeLocation < 0
        || indexedEdgeCostLocation < 0
        || indexedEdgeEndpointLocation < 0
      ) {
        gl.deleteProgram(indexedEdgeProgram);
        indexedEdgeProgram = null;
      } else {
        indexedEdgeViewportLocation = gl.getUniformLocation(indexedEdgeProgram, 'u_viewport_px');
        indexedEdgeViewOffsetLocation = gl.getUniformLocation(indexedEdgeProgram, 'u_view_offset_px');
        indexedEdgeViewScaleLocation = gl.getUniformLocation(indexedEdgeProgram, 'u_view_scale');
        indexedEdgeCycleMinutesLocation = gl.getUniformLocation(indexedEdgeProgram, 'u_cycle_minutes');
        indexedEdgeAlphaLocation = gl.getUniformLocation(indexedEdgeProgram, 'u_alpha');
        indexedEdgeThemeVariantLocation = gl.getUniformLocation(indexedEdgeProgram, 'u_theme_variant');
        indexedEdgeSlackSecondsLocation = gl.getUniformLocation(indexedEdgeProgram, 'u_edge_slack_seconds');
        indexedEdgeNodeTimeTextureLocation = gl.getUniformLocation(
          indexedEdgeProgram,
          'u_node_time_texture',
        );
        indexedEdgeNodeTimeTextureSizeLocation = gl.getUniformLocation(
          indexedEdgeProgram,
          'u_node_time_texture_size',
        );
        indexedEdgeNodeTimeTexture = gl.createTexture();
        if (!indexedEdgeNodeTimeTexture) {
          gl.deleteProgram(indexedEdgeProgram);
          indexedEdgeProgram = null;
        } else {
          gl.bindTexture(gl.TEXTURE_2D, indexedEdgeNodeTimeTexture);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
          indexedEdgeMaxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        }
      }
    } catch (error) {
      console.warn(
        'Indexed WebGL edge renderer initialization failed; falling back to packed edge-time buffers.',
        error,
      );
      if (indexedEdgeProgram) {
        gl.deleteProgram(indexedEdgeProgram);
      }
      indexedEdgeProgram = null;
      indexedEdgeNodeTimeTexture = null;
    }
  }

  const uploadIndexedEdgeNodeTimesTexture = (distSeconds) => {
    if (!(distSeconds instanceof Float32Array) && !(distSeconds instanceof Float64Array)) {
      throw new Error('distSeconds must be a Float32Array or Float64Array');
    }
    if (!indexedEdgeNodeTimeTexture || indexedEdgeMaxTextureSize <= 0) {
      throw new Error('indexed edge node-time texture is unavailable');
    }
    const { width, height, size } = computeNodeTimeTextureDimensions(
      distSeconds.length,
      indexedEdgeMaxTextureSize,
    );
    if (width !== indexedEdgeNodeTimeTextureWidth || height !== indexedEdgeNodeTimeTextureHeight) {
      indexedEdgeNodeTimeTextureWidth = width;
      indexedEdgeNodeTimeTextureHeight = height;
      gl.bindTexture(gl.TEXTURE_2D, indexedEdgeNodeTimeTexture);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.R32F,
        width,
        height,
        0,
        gl.RED,
        gl.FLOAT,
        null,
      );
    }

    let uploadData = distSeconds;
    if (distSeconds instanceof Float64Array) {
      if (
        !(indexedEdgeNodeTimeTextureFloat64Bridge instanceof Float32Array)
        || indexedEdgeNodeTimeTextureFloat64Bridge.length !== distSeconds.length
      ) {
        indexedEdgeNodeTimeTextureFloat64Bridge = new Float32Array(distSeconds.length);
      }
      indexedEdgeNodeTimeTextureFloat64Bridge.set(distSeconds);
      uploadData = indexedEdgeNodeTimeTextureFloat64Bridge;
    }
    if (size !== uploadData.length) {
      if (
        !(indexedEdgeNodeTimeTextureUploadBuffer instanceof Float32Array)
        || indexedEdgeNodeTimeTextureUploadBuffer.length !== size
      ) {
        indexedEdgeNodeTimeTextureUploadBuffer = new Float32Array(size);
      }
      indexedEdgeNodeTimeTextureUploadBuffer.fill(Number.POSITIVE_INFINITY);
      indexedEdgeNodeTimeTextureUploadBuffer.set(uploadData);
      uploadData = indexedEdgeNodeTimeTextureUploadBuffer;
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, indexedEdgeNodeTimeTexture);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      width,
      height,
      gl.RED,
      gl.FLOAT,
      uploadData,
    );
    return { width, height };
  };

  const resolveRendererViewport = (graphWidthPx, graphHeightPx, viewport, fitBoundingBoxPx) =>
    resolveViewportFrame(
      {
        gridWidthPx: graphWidthPx,
        gridHeightPx: graphHeightPx,
      },
      viewport,
      {
        frameWidthPx: canvas.width,
        frameHeightPx: canvas.height,
        fitBoundingBoxPx,
      },
    );

  const renderer = {
    mode: 'webgl',
    clear(options = {}) {
      syncCanvasToDisplaySize(canvas);
      const targetWidthPx = options.widthPx ?? canvas.width;
      const targetHeightPx = options.heightPx ?? canvas.height;
      if (!Number.isFinite(targetWidthPx) || targetWidthPx <= 0) {
        throw new Error('options.widthPx (or canvas.width) must be positive');
      }
      if (!Number.isFinite(targetHeightPx) || targetHeightPx <= 0) {
        throw new Error('options.heightPx (or canvas.height) must be positive');
      }

      const widthPx = Math.floor(targetWidthPx);
      const heightPx = Math.floor(targetHeightPx);
      if (canvas.width !== widthPx) {
        canvas.width = widthPx;
      }
      if (canvas.height !== heightPx) {
        canvas.height = heightPx;
      }

      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    },
    draw(pixelGrid, options = {}) {
      validatePixelGrid(pixelGrid);
      if (!syncCanvasToDisplaySize(canvas) && (!(canvas.width > 0) || !(canvas.height > 0))) {
        canvas.width = pixelGrid.widthPx;
        canvas.height = pixelGrid.heightPx;
      }

      gl.viewport(0, 0, canvas.width, canvas.height);
      const viewport = resolveRendererViewport(
        pixelGrid.widthPx,
        pixelGrid.heightPx,
        options.viewport,
        options.fitBoundingBoxPx,
      );
      bindQuadToProgram(program, positionLocation);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        pixelGrid.widthPx,
        pixelGrid.heightPx,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixelGrid.rgba,
      );
      if (textureLocation !== null) {
        gl.uniform1i(textureLocation, 0);
      }
      if (textureSizeLocation !== null) {
        gl.uniform2f(textureSizeLocation, pixelGrid.widthPx, pixelGrid.heightPx);
      }
      if (viewportSizeLocation !== null) {
        gl.uniform2f(viewportSizeLocation, canvas.width, canvas.height);
      }
      if (textureViewOffsetLocation !== null) {
        gl.uniform2f(textureViewOffsetLocation, viewport.offsetXPx, viewport.offsetYPx);
      }
      if (textureViewScaleLocation !== null) {
        gl.uniform1f(textureViewScaleLocation, viewport.effectiveScale);
      }
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return null;
    },
    drawTravelTimeEdges(edgeVertexData, options = {}) {
      if (!(edgeVertexData instanceof Float32Array)) {
        throw new Error('edgeVertexData must be a Float32Array');
      }
      if (edgeVertexData.length % 6 !== 0) {
        throw new Error('edgeVertexData length must be a multiple of 6 (x0,y0,t0,x1,y1,t1)');
      }
      const append = options.append ?? false;
      if (edgeVertexData.length === 0) {
        if (!append) {
          forgetUploadedEdgeGeometry();
        }
        return 0;
      }

      const cycleMinutes = options.cycleMinutes ?? DEFAULT_COLOUR_CYCLE_MINUTES;
      const themeVariant = getIsochroneThemeVariant(options.colourTheme ?? 'dark');
      const alpha = Number.isFinite(options.alpha) ? options.alpha : 1;
      const clampedAlpha = Math.max(0, Math.min(1, alpha));
      const reuseUploadedGeometry = options.reuseUploadedGeometry === true;
      if (!syncCanvasToDisplaySize(canvas) && (!(canvas.width > 0) || !(canvas.height > 0))) {
        const fallbackWidthPx = options.graphWidthPx ?? canvas.width;
        const fallbackHeightPx = options.graphHeightPx ?? canvas.height;
        canvas.width = Math.max(1, Math.floor(fallbackWidthPx));
        canvas.height = Math.max(1, Math.floor(fallbackHeightPx));
      }
      const graphWidthPx = options.graphWidthPx ?? canvas.width;
      const graphHeightPx = options.graphHeightPx ?? canvas.height;
      const viewport = resolveRendererViewport(
        graphWidthPx,
        graphHeightPx,
        options.viewport,
        options.fitBoundingBoxPx,
      );

      gl.viewport(0, 0, canvas.width, canvas.height);
      if (!append) {
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(edgeProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, edgeVertexBuffer);
      ensureEdgeVertexBufferCapacity(edgeVertexData.length);
      const shouldUploadGeometry = shouldUploadEdgeGeometry(
        lastUploadedEdgeVertexDataRef,
        lastUploadedEdgeVertexDataLength,
        edgeVertexData,
        {
          append,
          reuseUploadedGeometry,
          previousLayout: lastUploadedEdgeVertexDataLayout,
          layout: EDGE_VERTEX_LAYOUT_PLAIN,
        },
      );
      if (shouldUploadGeometry) {
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, edgeVertexData);
      }
      gl.enableVertexAttribArray(edgePositionLocation);
      gl.vertexAttribPointer(edgePositionLocation, 2, gl.FLOAT, false, 12, 0);
      gl.enableVertexAttribArray(edgeSecondsLocation);
      gl.vertexAttribPointer(edgeSecondsLocation, 1, gl.FLOAT, false, 12, 8);
      if (edgeViewportLocation !== null) {
        gl.uniform2f(edgeViewportLocation, canvas.width, canvas.height);
      }
      if (edgeViewOffsetLocation !== null) {
        gl.uniform2f(edgeViewOffsetLocation, viewport.offsetXPx, viewport.offsetYPx);
      }
      if (edgeViewScaleLocation !== null) {
        gl.uniform1f(edgeViewScaleLocation, viewport.effectiveScale);
      }
      if (edgeCycleMinutesLocation !== null) {
        gl.uniform1f(edgeCycleMinutesLocation, cycleMinutes);
      }
      if (edgeAlphaLocation !== null) {
        gl.uniform1f(edgeAlphaLocation, clampedAlpha);
      }
      if (edgeThemeVariantLocation !== null) {
        gl.uniform1f(edgeThemeVariantLocation, themeVariant);
      }
      gl.drawArrays(gl.LINES, 0, edgeVertexData.length / 3);
      if (append) {
        forgetUploadedEdgeGeometry();
      } else {
        rememberUploadedEdgeGeometry(edgeVertexData, EDGE_VERTEX_LAYOUT_PLAIN);
      }
      return edgeVertexData.length / 6;
    },
    drawTravelTimeEdgesFromNodeTimes(edgeVertexData, distSeconds, options = {}) {
      if (!indexedEdgeProgram || !indexedEdgeNodeTimeTexture) {
        throw new Error('indexed WebGL edge renderer is unavailable');
      }
      if (!(edgeVertexData instanceof Float32Array)) {
        throw new Error('edgeVertexData must be a Float32Array');
      }
      if (edgeVertexData.length % 12 !== 0) {
        throw new Error(
          'edgeVertexData length must be a multiple of 12 (two vertices of six floats per edge)',
        );
      }
      if (!(distSeconds instanceof Float32Array) && !(distSeconds instanceof Float64Array)) {
        throw new Error('distSeconds must be a Float32Array or Float64Array');
      }
      const append = options.append ?? false;
      if (edgeVertexData.length === 0 || distSeconds.length === 0) {
        if (!append) {
          forgetUploadedEdgeGeometry();
          // Nothing to draw, but the caller still expects a fresh frame -
          // without this, a route with zero eligible edges left whatever
          // the previous frame happened to show on screen.
          syncCanvasToDisplaySize(canvas);
          gl.viewport(0, 0, canvas.width, canvas.height);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
        }
        return 0;
      }

      const cycleMinutes = options.cycleMinutes ?? DEFAULT_COLOUR_CYCLE_MINUTES;
      const themeVariant = getIsochroneThemeVariant(options.colourTheme ?? 'dark');
      const alpha = Number.isFinite(options.alpha) ? options.alpha : 1;
      const clampedAlpha = Math.max(0, Math.min(1, alpha));
      const edgeSlackSeconds = options.edgeSlackSeconds ?? EDGE_INTERPOLATION_SLACK_SECONDS;
      if (!Number.isFinite(edgeSlackSeconds) || edgeSlackSeconds < 0) {
        throw new Error('options.edgeSlackSeconds must be a non-negative finite number');
      }
      const reuseUploadedGeometry = options.reuseUploadedGeometry === true;
      if (!syncCanvasToDisplaySize(canvas) && (!(canvas.width > 0) || !(canvas.height > 0))) {
        const fallbackWidthPx = options.graphWidthPx ?? canvas.width;
        const fallbackHeightPx = options.graphHeightPx ?? canvas.height;
        canvas.width = Math.max(1, Math.floor(fallbackWidthPx));
        canvas.height = Math.max(1, Math.floor(fallbackHeightPx));
      }
      const graphWidthPx = options.graphWidthPx ?? canvas.width;
      const graphHeightPx = options.graphHeightPx ?? canvas.height;
      const viewport = resolveRendererViewport(
        graphWidthPx,
        graphHeightPx,
        options.viewport,
        options.fitBoundingBoxPx,
      );

      gl.viewport(0, 0, canvas.width, canvas.height);
      if (!append) {
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(indexedEdgeProgram);

      const textureDimensions = uploadIndexedEdgeNodeTimesTexture(distSeconds);
      if (indexedEdgeNodeTimeTextureLocation !== null) {
        gl.uniform1i(indexedEdgeNodeTimeTextureLocation, 0);
      }
      if (indexedEdgeNodeTimeTextureSizeLocation !== null) {
        gl.uniform2i(
          indexedEdgeNodeTimeTextureSizeLocation,
          textureDimensions.width,
          textureDimensions.height,
        );
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, edgeVertexBuffer);
      ensureEdgeVertexBufferCapacity(edgeVertexData.length);
      const shouldUploadGeometry = shouldUploadEdgeGeometry(
        lastUploadedEdgeVertexDataRef,
        lastUploadedEdgeVertexDataLength,
        edgeVertexData,
        {
          append,
          reuseUploadedGeometry,
          previousLayout: lastUploadedEdgeVertexDataLayout,
          layout: EDGE_VERTEX_LAYOUT_NODE_INDEXED,
        },
      );
      if (shouldUploadGeometry) {
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, edgeVertexData);
      }
      gl.enableVertexAttribArray(indexedEdgePositionLocation);
      gl.vertexAttribPointer(indexedEdgePositionLocation, 2, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(indexedEdgeSourceNodeLocation);
      gl.vertexAttribPointer(indexedEdgeSourceNodeLocation, 1, gl.FLOAT, false, 24, 8);
      gl.enableVertexAttribArray(indexedEdgeTargetNodeLocation);
      gl.vertexAttribPointer(indexedEdgeTargetNodeLocation, 1, gl.FLOAT, false, 24, 12);
      gl.enableVertexAttribArray(indexedEdgeCostLocation);
      gl.vertexAttribPointer(indexedEdgeCostLocation, 1, gl.FLOAT, false, 24, 16);
      gl.enableVertexAttribArray(indexedEdgeEndpointLocation);
      gl.vertexAttribPointer(indexedEdgeEndpointLocation, 1, gl.FLOAT, false, 24, 20);
      if (indexedEdgeViewportLocation !== null) {
        gl.uniform2f(indexedEdgeViewportLocation, canvas.width, canvas.height);
      }
      if (indexedEdgeViewOffsetLocation !== null) {
        gl.uniform2f(indexedEdgeViewOffsetLocation, viewport.offsetXPx, viewport.offsetYPx);
      }
      if (indexedEdgeViewScaleLocation !== null) {
        gl.uniform1f(indexedEdgeViewScaleLocation, viewport.effectiveScale);
      }
      if (indexedEdgeCycleMinutesLocation !== null) {
        gl.uniform1f(indexedEdgeCycleMinutesLocation, cycleMinutes);
      }
      if (indexedEdgeAlphaLocation !== null) {
        gl.uniform1f(indexedEdgeAlphaLocation, clampedAlpha);
      }
      if (indexedEdgeThemeVariantLocation !== null) {
        gl.uniform1f(indexedEdgeThemeVariantLocation, themeVariant);
      }
      if (indexedEdgeSlackSecondsLocation !== null) {
        gl.uniform1f(indexedEdgeSlackSecondsLocation, edgeSlackSeconds);
      }
      gl.drawArrays(gl.LINES, 0, edgeVertexData.length / 6);
      if (append) {
        forgetUploadedEdgeGeometry();
      } else {
        rememberUploadedEdgeGeometry(edgeVertexData, EDGE_VERTEX_LAYOUT_NODE_INDEXED);
      }
      return edgeVertexData.length / 12;
    },
    readPixelsRgba(samplePixels) {
      if (!Array.isArray(samplePixels)) {
        throw new Error('samplePixels must be an array of [x, y] pairs');
      }

      const sampledRgba = new Uint8Array(samplePixels.length * 4);
      const onePixel = new Uint8Array(4);
      for (let sampleIndex = 0; sampleIndex < samplePixels.length; sampleIndex += 1) {
        const sample = samplePixels[sampleIndex];
        if (!Array.isArray(sample) || sample.length < 2) {
          throw new Error('samplePixels must contain [x, y] pairs');
        }
        const xPx = clampInt(Math.round(sample[0]), 0, canvas.width - 1);
        const yPx = clampInt(Math.round(sample[1]), 0, canvas.height - 1);
        const yReadPx = canvas.height - 1 - yPx;
        gl.readPixels(xPx, yReadPx, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, onePixel);
        sampledRgba[sampleIndex * 4] = onePixel[0];
        sampledRgba[sampleIndex * 4 + 1] = onePixel[1];
        sampledRgba[sampleIndex * 4 + 2] = onePixel[2];
        sampledRgba[sampleIndex * 4 + 3] = onePixel[3];
      }

      return sampledRgba;
    },
  };

  if (!indexedEdgeProgram || !indexedEdgeNodeTimeTexture) {
    delete renderer.drawTravelTimeEdgesFromNodeTimes;
  }

  if (travelTimeProgram && travelTimeTexture && isWebGl2) {
    renderer.drawTravelTimeGrid = function drawTravelTimeGrid(travelTimeGrid, options = {}) {
      validateTravelTimeGrid(travelTimeGrid);

      if (!syncCanvasToDisplaySize(canvas) && (!(canvas.width > 0) || !(canvas.height > 0))) {
        canvas.width = travelTimeGrid.widthPx;
        canvas.height = travelTimeGrid.heightPx;
      }

      const cycleMinutes = options.cycleMinutes ?? DEFAULT_COLOUR_CYCLE_MINUTES;
      const themeVariant = getIsochroneThemeVariant(options.colourTheme ?? 'dark');
      const viewport = resolveRendererViewport(
        travelTimeGrid.widthPx,
        travelTimeGrid.heightPx,
        options.viewport,
        options.fitBoundingBoxPx,
      );
      gl.viewport(0, 0, canvas.width, canvas.height);
      bindQuadToProgram(travelTimeProgram, travelTimePositionLocation);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, travelTimeTexture);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.R32F,
        travelTimeGrid.widthPx,
        travelTimeGrid.heightPx,
        0,
        gl.RED,
        gl.FLOAT,
        travelTimeGrid.seconds,
      );
      if (travelTimeTextureLocation !== null) {
        gl.uniform1i(travelTimeTextureLocation, 0);
      }
      if (travelTimeTextureSizeLocation !== null) {
        gl.uniform2f(travelTimeTextureSizeLocation, travelTimeGrid.widthPx, travelTimeGrid.heightPx);
      }
      if (travelTimeViewportSizeLocation !== null) {
        gl.uniform2f(travelTimeViewportSizeLocation, canvas.width, canvas.height);
      }
      if (travelTimeViewOffsetLocation !== null) {
        gl.uniform2f(travelTimeViewOffsetLocation, viewport.offsetXPx, viewport.offsetYPx);
      }
      if (travelTimeViewScaleLocation !== null) {
        gl.uniform1f(travelTimeViewScaleLocation, viewport.effectiveScale);
      }
      if (travelTimeCycleMinutesLocation !== null) {
        gl.uniform1f(travelTimeCycleMinutesLocation, cycleMinutes);
      }
      if (travelTimeThemeVariantLocation !== null) {
        gl.uniform1f(travelTimeThemeVariantLocation, themeVariant);
      }
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return null;
    };
  }

  return renderer;
}

export function createIsochroneRenderer(canvas, options = {}) {
  try {
    const webglRenderer = createWebGlIsochroneRenderer(canvas, options);
    return webglRenderer ?? createCanvas2dIsochroneRenderer(canvas);
  } catch (error) {
    console.warn('WebGL renderer initialization failed; falling back to 2D canvas renderer.', error);
    return createCanvas2dIsochroneRenderer(canvas);
  }
}

export function getOrCreateIsochroneRenderer(canvas) {
  const cached = canvas.__isochroneRenderer;
  if (cached && typeof cached.draw === 'function') {
    return cached;
  }

  const renderer = createIsochroneRenderer(canvas);
  canvas.__isochroneRenderer = renderer;
  return renderer;
}

export function blitPixelGridToCanvas(canvas, pixelGrid, options = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') {
    throw new Error('canvas must provide getContext("2d")');
  }
  validatePixelGrid(pixelGrid);
  const renderer = getOrCreateIsochroneRenderer(canvas);
  return renderer.draw(pixelGrid, {
    viewport: options.viewport,
    fitBoundingBoxPx: options.fitBoundingBoxPx,
  });
}
