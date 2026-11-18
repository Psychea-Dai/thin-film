// 顶点着色器（vertex shader）：只负责把一块 2×2 的平面铺满整个屏幕。
// position 的 x、y 本来就在 -1 ~ 1 之间，直接当作屏幕坐标输出，不需要相机变换。
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
