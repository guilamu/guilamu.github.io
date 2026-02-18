// scripts/generate.js
const https = require('https');
const fs = require('fs');

const USERNAME = 'guilamu';
const TOKEN = process.env.GITHUB_TOKEN;

function apiGet(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path,
      headers: {
        'User-Agent': 'guilamu-page',
        'Authorization': `Bearer ${TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    };
    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

// Convertit le Markdown basique du changelog en HTML
function markdownToHtml(md) {
  if (!md) return '<em>Aucun changelog disponible.</em>';
  return md
    .replace(/## (.+)/g, '<h4>$1</h4>')
    .replace(/### (.+)/g, '<h5>$1</h5>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^- (.+)/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
    .replace(/\n/g, '<br>');
}

function buildCard(repo, release) {
  const hasRelease = release && !release.message;
  const asset = hasRelease && release.assets && release.assets[0];
  const downloadUrl = asset ? asset.browser_download_url : (hasRelease ? release.zipball_url : null);
  const downloadLabel = asset ? asset.name : 'Source (.zip)';
  const changelog = hasRelease ? markdownToHtml(release.body) : '';
  const version = hasRelease ? release.tag_name : null;

  return `
  <div class="card">
    <div class="card-header">
      <h2><a href="${repo.html_url}" target="_blank">${repo.name}</a></h2>
      ${version ? `<span class="badge">${version}</span>` : '<span class="badge no-release">Pas de release</span>'}
    </div>
    <p class="description">${repo.description || '<em>Aucune description.</em>'}</p>
    ${downloadUrl ? `
    <a class="btn-download" href="${downloadUrl}">
      ⬇ Télécharger ${downloadLabel}
    </a>` : ''}
    ${changelog ? `
    <details>
      <summary>📋 Voir le changelog</summary>
      <div class="changelog">${changelog}</div>
    </details>` : ''}
    <div class="meta">
      ${repo.language ? `<span>🔧 ${repo.language}</span>` : ''}
      ${hasRelease ? `<span>📅 ${new Date(release.published_at).toLocaleDateString('fr-FR')}</span>` : ''}
      <span>⭐ ${repo.stargazers_count}</span>
    </div>
  </div>`;
}

async function main() {
  const repos = await apiGet(`/users/${USERNAME}/repos?type=public&per_page=100&sort=updated`);

  const cards = await Promise.all(
    repos
      .filter(r => !r.fork)
      .map(async (repo) => {
        const release = await apiGet(`/repos/${USERNAME}/${repo.name}/releases/latest`);
        return buildCard(repo, release);
      })
  );

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${USERNAME} — Extensions & Plugins</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0d1117; color: #c9d1d9; padding: 2rem; }
    h1 { text-align: center; margin-bottom: 0.5rem; color: #58a6ff; }
    .subtitle { text-align: center; color: #8b949e; margin-bottom: 2rem; font-size: 0.9rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 1.5rem; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1.25rem; display: flex; flex-direction: column; gap: 0.75rem; }
    .card-header { display: flex; justify-content: space-between; align-items: center; }
    .card h2 { font-size: 1.1rem; } .card h2 a { color: #58a6ff; text-decoration: none; }
    .card h2 a:hover { text-decoration: underline; }
    .badge { background: #238636; color: #fff; padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; }
    .badge.no-release { background: #30363d; }
    .description { color: #8b949e; font-size: 0.9rem; }
    .btn-download { display: inline-block; background: #238636; color: #fff; padding: 6px 14px; border-radius: 6px; text-decoration: none; font-size: 0.85rem; width: fit-content; }
    .btn-download:hover { background: #2ea043; }
    details summary { cursor: pointer; color: #58a6ff; font-size: 0.85rem; }
    .changelog { background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 0.75rem; margin-top: 0.5rem; font-size: 0.8rem; max-height: 200px; overflow-y: auto; }
    .changelog h4, .changelog h5 { color: #58a6ff; margin: 0.5rem 0 0.25rem; }
    .changelog ul { padding-left: 1.2rem; }
    .meta { display: flex; gap: 1rem; font-size: 0.75rem; color: #8b949e; margin-top: auto; padding-top: 0.5rem; border-top: 1px solid #21262d; }
    footer { text-align: center; margin-top: 3rem; color: #8b949e; font-size: 0.8rem; }
  </style>
</head>
<body>
  <h1>🔌 Mes Extensions & Plugins</h1>
  <p class="subtitle">Mis à jour le ${new Date().toLocaleDateString('fr-FR', {day:'numeric',month:'long',year:'numeric'})} à ${new Date().toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit'})}</p>
  <div class="grid">
    ${cards.join('\n')}
  </div>
  <footer>Généré automatiquement via GitHub Actions · <a href="https://github.com/${USERNAME}" style="color:#58a6ff">github.com/${USERNAME}</a></footer>
</body>
</html>`;

  fs.writeFileSync('index.html', html);
  console.log(`✅ Page générée avec ${cards.length} repos.`);
}

main().catch(console.error);
