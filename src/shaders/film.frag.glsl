// =============================================================================
// film.frag.glsl —— 薄膜干涉片元着色器（fragment shader）
//
// 每个像素都会执行一次这个程序，流程只有两步：
//   1. filmThickness(p)：算出这个位置的薄膜厚度（nm）
//   2. filmColor(d)    ：把厚度代入薄膜干涉公式，算出反射的 RGB 颜色
// 画面上没有任何手填的颜色渐变，所有颜色都来自第 2 步的物理公式。
//
// 原创代码，作者：Psychea-Dai（与 Claude 协作编写）。
// 参考资料（只参考原理，未复制代码）：
//   - Thin Film Interference for Computer Graphics, gamedev.net
//     https://www.gamedev.net/tutorials/programming/graphics/thin-film-interference-for-computer-graphics-r2962/
//   - 哈希函数 pcg2d 的算法来自论文：Mark Jarzynski & Marc Olano,
//     "Hash Functions for GPU Rendering", JCGT 2020, http://jcgt.org/published/0009/03/02/
//     （按论文描述自行编写）
// =============================================================================

varying vec2 vUv;

// ---- 由 JS 每帧传进来的数（uniform：对所有像素都一样的全局变量） ----
uniform vec2  uResolution;   // 画布像素尺寸
uniform float uTime;         // 流动时间（B 阶段开始走动）
uniform float uSeed;         // 每帧变化的随机种子（用于颗粒）

// 光学
uniform float uFilmIOR;
uniform vec3  uWavelengths;
uniform float uBandwidth;
uniform float uViewAngle;

// 厚度场（名字与 config.js 里的 CONFIG.film 一一对应）
uniform float uBaseThickness, uBaseGradient, uBaseNoise;
uniform vec2  uBlobHaloCenter, uBlobHaloRadius;
uniform float uBlobHaloAmp;
uniform vec2  uBlobCoreCenter;
uniform float uBlobCoreRadius, uBlobCoreAmp;
uniform float uWarpScale, uWarpAmount, uWarpOctaves;
uniform float uStreakFreq, uStreakAmp, uStreakStretch;
uniform float uNeckWidth, uNeckThin;
uniform float uRingFreq, uRingAmp;
uniform float uDustDensity, uDustAmp;

// 心形区域（名字与 CONFIG.film.heart* 对应）
uniform vec2  uHeartTip;      // 心形尖端的初始位置（未放大时）
uniform float uHeartSize;     // 当前大小（JS 每帧按放大进度计算）
uniform float uHeartBaseSize; // 初始大小
uniform float uHeartTilt, uHeartGrow;
uniform float uHeartPink, uHeartBlue, uHeartGradAngle, uHeartNoise, uHeartVeil;
uniform float uHeartEdgeNoise, uHeartFeather, uHeartThinWidth, uHeartThinAmount;
uniform float uHeartFlow;     // 心形边缘流纹的强度
uniform vec2  uHeartLead;     // 尖端位置（领先）
uniform vec2  uHeartTrail;    // 心瓣参考位置（落后）-> 两者之差就是拖拽变形
uniform float uHeartProgress; // 放大进度 0~1（0 = 原样，1 = 接近全屏）
uniform float uHeartDeform;   // 放大过程中的有机变形量
uniform float uOutsideSaturation; // 心形以外区域的饱和度倍数

// 构图
uniform float uFrameAspect;

// 交互（C 阶段）
uniform vec2  uPointer;         // 变形中心
uniform vec2  uPointerOffset;   // 弹簧驱动的变形向量
uniform float uPointerRadius, uPointerStrength, uPointerThicken;

// 调色
uniform float uExposure, uSaturation, uGrain;
uniform vec3  uTint, uBlackPoint;

const float PI = 3.14159265359;

// =============================================================================
// 第 0 部分：噪声工具
// =============================================================================

// pcg2d：把两个整数打乱成两个“看起来随机”的整数。同样的输入永远得到同样的输出。
uvec2 pcg2d(uvec2 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * 1664525u;
  v.y += v.x * 1664525u;
  v = v ^ (v >> 16u);
  v.x += v.y * 1664525u;
  v.y += v.x * 1664525u;
  v = v ^ (v >> 16u);
  return v;
}

// 网格格子 -> 0~1 的随机数（加 50000 是为了避免负数转无符号整数）
vec2 hash22(vec2 cell) {
  uvec2 h = pcg2d(uvec2(ivec2(cell) + ivec2(50000)));
  return vec2(h) / 4294967295.0;
}

// 梯度噪声（gradient noise）：平滑连续的随机起伏，输出大约 -0.7 ~ 0.7
float gnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);   // 五次平滑曲线
  // 每个格点一个随机方向，取它与“格点->当前点”向量的点积
  float a = hash22(i).x                  * 2.0 * PI;
  float b = hash22(i + vec2(1.0, 0.0)).x * 2.0 * PI;
  float c = hash22(i + vec2(0.0, 1.0)).x * 2.0 * PI;
  float d = hash22(i + vec2(1.0, 1.0)).x * 2.0 * PI;
  float va = dot(vec2(cos(a), sin(a)), f);
  float vb = dot(vec2(cos(b), sin(b)), f - vec2(1.0, 0.0));
  float vc = dot(vec2(cos(c), sin(c)), f - vec2(0.0, 1.0));
  float vd = dot(vec2(cos(d), sin(d)), f - vec2(1.0, 1.0));
  return mix(mix(va, vb, u.x), mix(vc, vd, u.x), u.y);
}

// fbm（分形布朗运动）：把多层噪声叠起来，每层频率翻倍、振幅减半。
// 每层还旋转一下，避免看出网格方向。输出大约 -1 ~ 1。
const mat2 OCTAVE_ROT = mat2(0.8, 0.6, -0.6, 0.8);
float fbm(vec2 p, float octaves) {
  float sum = 0.0;
  float amp = 0.55;
  for (int i = 0; i < 6; i++) {
    if (float(i) >= octaves) break;
    sum += amp * gnoise(p);
    p = OCTAVE_ROT * p * 2.03 + vec2(17.1, 3.7);
    amp *= 0.5;
  }
  return sum * 1.4;
}

// =============================================================================
// 第 1 部分：心形的距离场（signed distance field）
// 返回值：在心形外是正数（离边缘多远），在里面是负数。
//
// 心形 = 一个旋转 45° 的正方形（菱形）+ 两个圆。
// 两个圆的圆心在菱形上面两条边的中点，半径是半条边长，正好鼓出两个“心瓣”。
// 这里先按“尖朝下、心瓣朝上”的标准姿势计算。
// =============================================================================
float sdHeartUpright(vec2 q, float a) {
  // a：菱形中心到四个角的距离。尖端在 (0, -a)，上方的凹口在 (0, a)
  float diamond = (abs(q.x) + abs(q.y) - a) * 0.70710678;    // 到菱形边的距离
  float r = a * 0.70710678;                                   // 圆半径 = 半条边长
  float lobeL = length(q - vec2(-0.5 * a, 0.5 * a)) - r;
  float lobeR = length(q - vec2( 0.5 * a, 0.5 * a)) - r;
  return min(diamond, min(lobeL, lobeR));                     // min = 并集
}

// =============================================================================
// 第 2 部分：厚度场
// 返回三样东西：心形外的厚度 hOut、心形内的厚度 hIn、心形遮罩 mask（0 外，1 内，边缘羽化）。
// 两种厚度分别算颜色，再按 mask 混合 -> 心形边缘是柔和的“羽化”，而不是彩色描边。
// =============================================================================
struct Film {
  float hOut;
  float hIn;
  float mask;
};

Film filmThickness(vec2 p) {
  float t = uTime;

  // ---- 2.0 交互变形：指针附近的坐标被往回挪 -> 内容看起来被推向移动方向 ----
  vec2 dpt = p - uPointer;
  float fall = exp(-dot(dpt, dpt) / (uPointerRadius * uPointerRadius)); // 高斯衰减：中心 1，远处 0
  p -= uPointerOffset * fall;
  float push = fall * uPointerStrength;

  // ---- 2.1 心形几何（先算，因为外面的薄膜要根据心形大小被挤压） ----
  float a = uHeartSize;
  vec2 rightDir = vec2(cos(radians(uHeartTilt)), sin(radians(uHeartTilt))); // 尖端 -> 心瓣的方向
  vec2 perpDir = vec2(-rightDir.y, rightDir.x);
  // 拖拽：离尖端越远的点，越靠近“落后”的位置
  float x0 = dot(p - uHeartTrail, rightDir);
  float wLag = smoothstep(-0.2 * a, 2.2 * a, x0);           // 0 = 尖端附近，1 = 心瓣末端
  vec2 tip = mix(uHeartLead, uHeartTrail, wLag);
  vec2 center = tip + rightDir * a;                          // 菱形中心在尖端右侧 a 处
  vec2 d = p - center;
  // 旋转到“标准姿势”：标准姿势的 y 轴（尖端 -> 心瓣）对应屏幕上的 rightDir，于是尖端朝左，形成 <3
  vec2 local = vec2(dot(d, perpDir), dot(d, rightDir));
  vec2 ln = local / a;                                       // 按心形大小归一化的坐标：纹理跟着心形一起放大
  float sd = sdHeartUpright(local, a);
  sd -= uHeartGrow;                                          // 整体膨胀（低频、鼓点、呼吸驱动）
  // 边缘随机波动：一层随时间轻轻抖动，一层只随放大进度变化（倒放时完全原路返回）
  sd += uHeartEdgeNoise * a * fbm(ln * 2.2 + vec2(11.0, 3.0) + 0.06 * t, 3.0);
  sd += uHeartDeform * a * sin(3.14159 * uHeartProgress) * fbm(ln * 1.1 + vec2(4.0, 9.0) + uHeartProgress * 0.8, 3.0);

  // ---- 2.2 挤压：心形放大时，把外面的薄膜沿径向压缩到剩下的空间里 ----
  // 思路：以心形中心为原点，“放大后心形边缘”对应“原来心形边缘”，远处（rFar）保持不动，中间线性压缩。
  // 外面所有图案（色团、光晕、流纹）都用压缩后的坐标 ps 来算，所以它们不会被心形盖掉，只是被挤扁。
  vec2 c0 = uHeartTip + rightDir * uHeartBaseSize;           // 原来的心形中心
  vec2 c1 = uHeartTrail + rightDir * a;                      // 现在的心形中心
  float R0 = 1.05 * uHeartBaseSize;
  float R1 = 1.05 * a;
  float rFar = max(2.1 * R1, 1.3);
  vec2 v = p - c1;
  float rho = length(v);
  vec2 dirV = v / max(rho, 1e-5);
  vec2 ps;
  if (rho < R1) {
    ps = c0 + dirV * rho * (R0 / R1);
  } else if (rho < rFar) {
    float rs = R0 + (rho - R1) * (rFar - R0) / (rFar - R1);
    vec2 cMix = mix(c0, c1, (rho - R1) / (rFar - R1));
    ps = cMix + dirV * rs;
  } else {
    ps = p;
  }

  // ---- 2.3 域扭曲：先算两层噪声向量，再用它们去推动坐标 ----
  vec2 q = ps * uWarpScale;
  vec2 w1 = vec2(fbm(q + vec2(1.7, 9.2) + vec2(0.11, 0.03) * t, uWarpOctaves),
                 fbm(q + vec2(8.3, 2.8) - vec2(0.04, 0.09) * t, uWarpOctaves));
  vec2 w2 = vec2(fbm(q + 1.7 * w1 + vec2(4.1, 6.3) + 0.06 * t, uWarpOctaves),
                 fbm(q + 1.7 * w1 + vec2(7.9, 1.4) - 0.05 * t, uWarpOctaves));
  vec2 pw = ps + uWarpAmount * w2;          // 被扭曲后的坐标

  // ---- 2.4 背景：一级白附近，左下略厚（暖），右上略薄（冷） ----
  float h = uBaseThickness;
  h += uBaseGradient * dot(ps, vec2(-0.7071, -0.7071));
  h += uBaseNoise * fbm(ps * 1.3 + 3.0 + 0.02 * t, 3.0);

  // ---- 2.5 外圈光晕：长尾巴的圆形隆起 -> 金色到深紫 ----
  vec2 ph = ps + uWarpAmount * 0.45 * w2;   // 光晕只用较弱的扭曲，边缘保持柔顺
  vec2 dh = (ph - uBlobHaloCenter) / uBlobHaloRadius;
  float rh2 = dot(dh, dh);
  float halo = pow(1.0 + rh2, -1.7);
  // 1 - exp(-k·x)：中心处“饱和”成一片平台（参考图里大片的深紫），外圈保持长尾巴（金色）
  float haloSat = (1.0 - exp(-4.0 * halo)) / (1.0 - exp(-4.0));
  h += uBlobHaloAmp * haloSat;
  float rh = sqrt(rh2);
  h += uRingAmp * sin(rh * uRingFreq * 0.1 * 6.2831) * smoothstep(0.4, 1.0, rh) * smoothstep(2.6, 1.3, rh);

  // ---- 2.6 流动坐标：色团“头部”绕成同心弧，“尾部”变成平行线流向心形尖端 ----
  vec2 flowDir = normalize(uHeartTip - uBlobCoreCenter);   // 在压缩坐标里，尖端始终在原位
  vec2 flowPerp = vec2(-flowDir.y, flowDir.x);
  vec2 lc = pw - uBlobCoreCenter;
  float along  = dot(lc, flowDir);
  float across = dot(lc, flowPerp);
  float r = length(lc);
  float headBlend = smoothstep(-0.03, 0.09, along);
  float converge = 1.0 + 2.4 * max(along, 0.0);
  float streamCoord = mix(r, across * converge, headBlend);

  // ---- 2.7 内核 ----
  vec2 dc = vec2(along / 1.45, across) / uBlobCoreRadius;
  float core = exp(-dot(dc, dc));
  h += uBlobCoreAmp * core;

  // ---- 2.8 颈部：内核到心形尖端之间，膜被抽薄 ----
  float tail = exp(-pow(across * converge / 0.07, 2.0)) * smoothstep(0.02, 0.14, along);
  vec2 ab = uHeartTip - uBlobCoreCenter;
  float seg = clamp(dot(lc, ab) / dot(ab, ab), 0.0, 1.0);
  float dSeg = length(lc - ab * seg);
  float neck = max(exp(-pow(dSeg / uNeckWidth, 2.0)) * smoothstep(0.1, 0.5, seg), tail * 0.8);
  neck *= smoothstep(length(ab) + 0.06, length(ab) - 0.02, along);
  h -= uNeckThin * neck;

  // ---- 2.9 心形边缘的流纹：沿心形轮廓的一圈圈等距线 ----
  // 在尖端左边，这些等距线被拉成 <<< 形，再和色团流过来的平行带子融成一体。
  float sdOut = max(sd, 0.0);
  float nearTip = smoothstep(1.4, -0.6, ln.y);              // 尖端一侧强，心瓣一侧弱
  float wHeart = exp(-sdOut / (0.03 + 0.05 * a)) * mix(0.06, 1.0, nearTip);
  wHeart *= uHeartFlow;
  // 两套坐标按权重混合：靠近心形用“到心形的距离”，靠近色团用原来的流动坐标
  float heartCoord = sdOut * 1.6;
  float flowCoord = mix(streamCoord, heartCoord, clamp(wHeart * 1.3, 0.0, 1.0));

  // ---- 2.10 细密平行流纹 ----
  vec2 sc = vec2(along * uStreakStretch, flowCoord * 9.0);
  float wobble = fbm(sc + vec2(-0.35 * t, 0.0), 3.0);
  // -t * 0.35 * wHeart：心形边缘的等距线不断向外“流淌”出去
  float lines = sin(flowCoord * uStreakFreq * 3.0 + wobble * 2.8 - t * (0.08 + 0.35 * wHeart));
  lines = sign(lines) * pow(abs(lines), 0.7);
  float streakMask = clamp(core * 1.1 + neck * 1.1, 0.0, 1.0);
  streakMask *= streakMask;
  streakMask *= smoothstep(-0.11, -0.03, along);
  streakMask = max(streakMask, wHeart * 0.6);
  h += uStreakAmp * lines * streakMask;

  h += uPointerThicken * push * (0.6 + 0.4 * lines);

  // ---- 2.11 小液滴 ----
  vec2 g = ps * 42.0;
  vec2 cell = floor(g);
  vec2 rnd = hash22(cell + 91.0);
  if (rnd.x < uDustDensity) {
    vec2 c = cell + 0.25 + 0.5 * hash22(cell + 7.0);
    vec2 dd = g - c;
    float ang = rnd.y * 6.2831;
    dd = mat2(cos(ang), sin(ang), -sin(ang), cos(ang)) * dd;
    dd.x *= 0.45;
    h += uDustAmp * exp(-dot(dd, dd) / 0.0025);
  }

  // 心形外围一圈膜被抽薄（偏冷白），让心形“浮”在底色上
  h -= uHeartThinAmount * exp(-sdOut / uHeartThinWidth);

  // ---- 2.12 心形内部的厚度：粉（uHeartPink）到蓝（uHeartBlue）的渐变 + 缓慢流动的起伏 ----
  vec2 gdir = vec2(cos(radians(uHeartGradAngle)), sin(radians(uHeartGradAngle)));
  float g01 = clamp(0.5 + dot(d - rightDir * 0.25 * a, gdir) / (2.3 * a), 0.0, 1.0);
  float hIn = mix(uHeartPink, uHeartBlue, smoothstep(0.0, 1.0, g01));
  hIn += uHeartNoise * fbm(ln * 1.6 - vec2(0.0, 0.08 * t), 3.0);

  // ---- 2.13 羽化遮罩：边缘过渡宽度 = 心形大小 × uHeartFeather ----
  float feather = uHeartFeather * a;
  float mask = smoothstep(feather * 0.5, -feather * 0.5, sd);

  Film f;
  f.hOut = max(h, 0.0);
  f.hIn = max(hIn, 0.0);
  f.mask = mask;
  return f;
}

// =============================================================================
// 第 3 部分：薄膜干涉 —— 厚度 d（nm）-> 反射颜色
//
// 光照到膜上，一部分在上表面反射，一部分进入膜、在下表面反射后再出来。
// 两束光走过的路程差（光程差，optical path difference）= 2 * n * d * cosθt。
// 路程差刚好是波长的整数倍还是半整数倍，决定了这个波长是被加强还是抵消。
// 不同波长被加强的程度不同，于是出现颜色。
// =============================================================================

// 单个波长的反射率（Airy 公式，考虑了光在膜里多次来回反射）
float airyReflectance(float d, float lambda, float n2, float cosT, float r12, float r23) {
  float delta = 4.0 * PI * n2 * d * cosT / lambda;  // 相位差 = 2π × 光程差 / 波长
  float c = cos(delta);
  float num = r12 * r12 + r23 * r23 + 2.0 * r12 * r23 * c;
  float den = 1.0 + r12 * r12 * r23 * r23 + 2.0 * r12 * r23 * c;
  return num / den;
}

vec3 filmColor(float d) {
  float n1 = 1.0;          // 膜外是空气
  float n2 = uFilmIOR;     // 膜本身
  float n3 = 1.0;          // 膜的另一侧也是空气（肥皂膜）
  // 斯涅尔定律（Snell's law）：光进入膜后折射，角度变小
  float sinT = sin(radians(uViewAngle)) * n1 / n2;
  float cosT = sqrt(1.0 - sinT * sinT);
  // 菲涅尔振幅系数（Fresnel，这里用正入射近似）。
  // r12 为负、r23 为正：上表面反射多了半个波长的相位翻转，
  // 所以极薄的膜（d≈0）两束光正好抵消 -> 黑色。参考图里的黑色撕裂区就是这个原理。
  float r12 = (n1 - n2) / (n1 + n2);
  float r23 = (n2 - n3) / (n2 + n3);
  float rMax = 4.0 * r12 * r12 / pow(1.0 + r12 * r12, 2.0);  // 理论最大反射率，用来归一化

  vec3 R = vec3(0.0);
  for (int k = 0; k < 3; k++) {
    float lam = uWavelengths[k];
    // 每个通道在代表波长两侧各取一个样本，权重 1:2:1
    float s = 0.5 * airyReflectance(d, lam, n2, cosT, r12, r23)
            + 0.25 * airyReflectance(d, lam - uBandwidth, n2, cosT, r12, r23)
            + 0.25 * airyReflectance(d, lam + uBandwidth, n2, cosT, r12, r23);
    R[k] = s;
  }
  return R / rMax;
}

// =============================================================================
// 第 4 部分：调色与输出
// =============================================================================
vec3 linearToSRGB(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  // 以屏幕高度为 1 的坐标，中心为 (0,0)
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
  // 构图适配：画面按 16:9（1920×1080）设计。
  // 比 16:9 更宽的屏幕：高度对齐，两侧多露出一些底色；
  // 比 16:9 更窄的屏幕（方屏、竖屏手机）：整体缩小，保证 16:9 画框的宽度完整可见。
  float aspect = uResolution.x / uResolution.y;
  if (aspect < uFrameAspect) p *= uFrameAspect / aspect;

  Film f = filmThickness(p);
  // 心形外：薄膜干涉色，饱和度额外降低（uOutsideSaturation）
  vec3 colOut = filmColor(f.hOut);
  float lumOut = dot(colOut, vec3(0.2126, 0.7152, 0.0722));
  colOut = mix(vec3(lumOut), colOut, uOutsideSaturation);
  // 心形内：干涉色 + 背光提亮（像薄膜后面有一面亮墙，颜色变成粉彩；颜色本身仍来自厚度）
  vec3 colIn = mix(filmColor(f.hIn), vec3(1.0), uHeartVeil);
  // 羽化混合
  vec3 col = mix(colOut, colIn, f.mask);

  col *= uExposure * uTint;
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(luma), col, uSaturation);
  col = uBlackPoint + (1.0 - uBlackPoint) * col;

  vec3 srgb = linearToSRGB(col);
  float n = hash22(gl_FragCoord.xy + uSeed * 1000.0).x - 0.5;
  srgb += n * uGrain;

  gl_FragColor = vec4(srgb, 1.0);
}
