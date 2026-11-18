// Vite 配置：base 设为 './'，打包后的网页放在任意子文件夹（如作品集网站的 /works/thin-film/）都能打开
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    chunkSizeWarningLimit: 800, // Three.js 本身约 550KB，属正常，提高警告阈值
  },
});
