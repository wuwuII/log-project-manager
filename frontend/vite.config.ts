import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  /**
   * ⚠️ 构建目标必须压到 es2019（2026-10-03 用户机器崩溃后加）：
   *   目标机是不联网的 Windows，Edge 从安装起从未更新过。
   *   默认 target（'modules'）不会把 ?? / ?. / 类字段等新语法降级，
   *   老引擎遇到新语法会直接抛语法错误整页崩。
   *   API 层面的缺口（toSorted 等）由 public/polyfills.js 兜底。
   */
  build: {
    target: 'es2019',
    cssTarget: 'chrome79',
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    hmr: false,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
