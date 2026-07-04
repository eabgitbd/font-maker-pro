# Font Maker Pro

A browser-based vector font editor (React + Tailwind + opentype.js), built with Vite.

## Run locally

```bash
npm install
npm run dev
```

Then open the URL Vite prints (usually http://localhost:5173).

## Publish on GitHub Pages

1. Push this project to a new GitHub repository (see commands in the chat where this
   was generated, or run `git init && git add . && git commit -m "Font Maker Pro" && git remote add origin <your-repo-url> && git push -u origin main`).
2. In `vite.config.js`, set `base: '/<your-repo-name>/'` to match your repo's name
   (already set to `/font-maker-pro/` — change it if you rename the repo).
3. In your GitHub repo: **Settings → Pages → Build and deployment → Source → GitHub Actions**.
4. Push to `main` (or re-run the workflow from the **Actions** tab). The included
   workflow at `.github/workflows/deploy.yml` builds the site and deploys it automatically.
5. Your site will be live at `https://<your-username>.github.io/<your-repo-name>/`.

## Publish on Vercel or Netlify (simpler, no config needed)

Both auto-detect Vite. Just import the GitHub repo in either dashboard and click deploy —
no `base` path changes needed since they serve from the domain root.
