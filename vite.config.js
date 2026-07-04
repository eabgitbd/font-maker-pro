import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// IMPORTANT: if you deploy to GitHub Pages at https://<user>.github.io/<repo-name>/,
// set `base` below to '/<repo-name>/'. If you deploy to Vercel/Netlify, or to a custom
// domain / user-root GitHub Pages site (https://<user>.github.io/), leave it as '/'.
export default defineConfig({
  plugins: [react()],
  base: '/font-maker-pro/',
});
