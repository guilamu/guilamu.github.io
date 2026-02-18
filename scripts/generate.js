const fs = require('fs');

const USERNAME = 'guilamu';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const POE_API_KEY = process.env.POE_API_KEY;
const CACHE_FILE = 'ai_cache.json';
const VALID_TAGS = ['Gravity Forms', 'IA', 'Wordpress', 'Outils', 'Données'];

// --- UTILITAIRES ---

async function apiGet(path) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      'User-Agent': 'guilamu-page',
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
  if (!response.ok) throw new Error(`GitHub API Error: ${response.status} ${response.statusText}`);
  return response.json();
}

async function poeApiCall(model, messages) {
  if (!POE_API_KEY) {
    console.warn('⚠️ POE_API_KEY is missing. Skipping AI generation.');
    return null;
  }

  try {
    const response = await fetch('https://api.poe.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${POE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model, messages, temperature: 0.5 })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error(`POE API Error: ${response.status}`, err);
      return null;
    }

    const data = await response.json();
    return data.choices[0].message.content;
  } catch (error) {
    console.error('POE API Request Failed:', error);
    return null;
  }
}

async function getLatestAIModel() {
  if (!POE_API_KEY) return 'Claude-3-Haiku';

  try {
    const response = await fetch('https://api.poe.com/v1/models', {
      headers: { 'Authorization': `Bearer ${POE_API_KEY}` }
    });
    if (!response.ok) throw new Error('Failed to fetch models');

    const data = await response.json();
    const haikuModels = data.data
      .filter(m => m.metadata?.display_name?.includes('Claude') && m.metadata?.display_name?.includes('Haiku'))
      .sort((a, b) => b.metadata.display_name.localeCompare(a.metadata.display_name, undefined, { numeric: true, sensitivity: 'base' }));

    if (haikuModels.length > 0) {
      console.log(`🤖 Using model: ${haikuModels[0].metadata.display_name} (${haikuModels[0].id})`);
      return haikuModels[0].id;
    }

    const sonnetModels = data.data
      .filter(m => m.metadata?.display_name?.includes('Claude') && m.metadata?.display_name?.includes('Sonnet'))
      .sort((a, b) => b.metadata.display_name.localeCompare(a.metadata.display_name, undefined, { numeric: true, sensitivity: 'base' }));

    if (sonnetModels.length > 0) {
      console.log(`🤖 Using fallback model: ${sonnetModels[0].metadata.display_name}`);
      return sonnetModels[0].id;
    }
  } catch (e) {
    console.error('Error fetching models:', e);
  }
  return 'Claude-3-Haiku';
}

async function getLatestSonnetModel() {
  if (!POE_API_KEY) return 'Claude-3-Sonnet';

  try {
    const response = await fetch('https://api.poe.com/v1/models', {
      headers: { 'Authorization': `Bearer ${POE_API_KEY}` }
    });
    if (!response.ok) throw new Error('Failed to fetch models');

    const data = await response.json();
    const sonnetModels = data.data
      .filter(m => m.metadata?.display_name?.includes('Claude') && m.metadata?.display_name?.includes('Sonnet'))
      .sort((a, b) => b.metadata.display_name.localeCompare(a.metadata.display_name, undefined, { numeric: true, sensitivity: 'base' }));

    if (sonnetModels.length > 0) {
      console.log(`✍️ Blog model: ${sonnetModels[0].metadata.display_name}`);
      return sonnetModels[0].id;
    }
  } catch (e) {
    console.error('Error fetching Sonnet model:', e);
  }
  return 'Claude-3-Haiku'; // fallback
}

// --- CACHE ---

function loadCache() {
  if (fs.existsSync(CACHE_FILE)) {
    try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (e) { }
  }
  return {};
}

function saveCache(cache) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

// --- AI GENERATION ---

async function getProjectMetadata(repo, model, cache) {
  const cacheKey = `meta_${repo.id}`;
  if (cache[cacheKey]) return cache[cacheKey];

  console.log(`🧠 Generating metadata for ${repo.name}...`);
  const prompt = `
Projet GitHub: ${repo.name}
Description actuelle: ${repo.description || 'Aucune'}
Langage: ${repo.language || 'Inconnu'}

Tâche:
1. Attribue à ce projet UN OU PLUSIEURS tags parmi cette liste UNIQUEMENT : "Gravity Forms", "IA", "Wordpress", "Outils", "Données". Un projet peut avoir plusieurs tags.
2. Rédige une très courte description (max 20 mots) en français.

Réponds UNIQUEMENT avec ce JSON (pas d'autre texte) :
{
  "tags": ["Tag1", "Tag2"],
  "description_fr": "Description courte"
}
  `;

  try {
    const content = await poeApiCall(model, [{ role: 'user', content: prompt }]);
    if (!content) return { tags: ['Outils'], description_fr: repo.description || repo.name };

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const json = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(content);

    // Validate tags: must be an array of valid strings
    if (!Array.isArray(json.tags) || json.tags.length === 0) {
      json.tags = ['Outils'];
    } else {
      json.tags = json.tags.filter(t => VALID_TAGS.includes(t));
      if (json.tags.length === 0) json.tags = ['Outils'];
    }

    if (typeof json.description_fr !== 'string' || !json.description_fr) {
      json.description_fr = repo.description || repo.name;
    }

    cache[cacheKey] = json;
    return json;
  } catch (e) {
    console.error(`Error parsing AI JSON for ${repo.name}:`, e);
    return { tags: ['Outils'], description_fr: repo.description || repo.name };
  }
}

async function getReleasePost(repo, release, model, cache) {
  const cacheKey = `post_${release.id}`;
  if (cache[cacheKey]) return cache[cacheKey];

  console.log(`✍️ Writing blog post for ${repo.name} ${release.tag_name}...`);
  const prompt = `
Changelog de la mise à jour ${release.tag_name} du projet "${repo.name}" :
${release.body || 'Pas de changelog.'}

Rédige un unique paragraphe HTML (<p>...</p>) en français décrivant factuellement ce qui a changé dans cette version. Aucune formule de politesse, aucun emoji, aucune liste. Uniquement les faits.
  `;

  const raw = await poeApiCall(model, [{ role: 'user', content: prompt }]);
  if (raw) {
    // Strip markdown code fences if the model wraps its response
    const content = raw.replace(/^```[\w]*\n?/m, '').replace(/\n?```$/m, '').trim();
    cache[cacheKey] = content;
    return content;
  }
  return null;
}

// --- HTML GENERATORS ---

function buildCard(repo, release, aiMeta) {
  const version = release ? release.tag_name : null;
  const tags = (aiMeta?.tags && Array.isArray(aiMeta.tags)) ? aiMeta.tags : ['Outils'];
  // data-tags is a JSON array string for JS filtering
  const dataTagsAttr = JSON.stringify(tags);
  const releaseUrl = release ? `https://github.com/${USERNAME}/${repo.name}/releases/download/${release.tag_name}/${repo.name}.zip` : null;

  return `
  <div class="card" data-tags='${dataTagsAttr}'>
    <div class="card-header">
      <h2><a href="${repo.html_url}" target="_blank">${repo.name}</a></h2>
      <div class="badges">
        ${tags.map(t => `<span class="badge category-badge">${t}</span>`).join('')}
        ${version ? `<span class="badge version-badge">${version}</span>` : ''}
      </div>
    </div>
    <p class="description">${aiMeta?.description_fr || repo.description || 'Projet personnel'}</p>
    <div class="actions">
      ${release ? `<a href="blog-${repo.name}.html" class="btn-secondary">Voir les mises à jour</a>` : ''}
      ${releaseUrl ? `<a href="${releaseUrl}" class="btn-download" target="_blank">Télécharger</a>` : ''}
    </div>
    <div class="meta">
      <span>⭐ ${repo.stargazers_count}</span>
      ${repo.language ? `<span>${repo.language}</span>` : ''}
    </div>
  </div>`;
}

// --- MAIN ---

async function main() {
  const cache = loadCache();

  console.log('📥 Fetching repositories...');
  const metaModel = await getLatestAIModel();
  const blogModel = await getLatestSonnetModel();
  let repos = await apiGet(`/users/${USERNAME}/repos?type=public&per_page=100&sort=updated`);
  repos = repos.filter(r => !r.fork);

  const projects = [];

  for (const repo of repos) {
    try {
      console.log(`Processing ${repo.name}...`);

      let releases = [];
      try {
        releases = await apiGet(`/repos/${USERNAME}/${repo.name}/releases?per_page=20`);
      } catch (e) {
        console.warn(`No releases for ${repo.name}: ${e.message}`);
      }

      const aiMeta = await getProjectMetadata(repo, metaModel, cache);

      const blogPosts = [];
      for (const release of releases) {
        try {
          const postContent = await getReleasePost(repo, release, blogModel, cache);
          if (postContent) {
            blogPosts.push({
              version: release.tag_name,
              date: release.published_at,
              content: postContent,
              releaseUrl: `https://github.com/${USERNAME}/${repo.name}/releases/download/${release.tag_name}/${repo.name}.zip`
            });
          }
        } catch (err) {
          console.error(`Error generating blog post for ${repo.name} ${release.tag_name}:`, err);
        }
      }

      const latestRelease = releases.length > 0 ? releases[0] : null;
      const latestReleaseUrl = latestRelease ? `https://github.com/${USERNAME}/${repo.name}/releases/download/${latestRelease.tag_name}/${repo.name}.zip` : null;

      if (blogPosts.length > 0) {
        const blogHtml = generateBlogPage(repo, blogPosts, aiMeta, latestReleaseUrl);
        fs.writeFileSync(`blog-${repo.name}.html`, blogHtml);
      }

      projects.push({ repo, latestRelease, latestReleaseUrl, aiMeta });
    } catch (repoError) {
      console.error(`🔥 Error processing ${repo.name}:`, repoError);
    }
  }

  saveCache(cache);

  const html = generateIndexPage(projects);
  fs.writeFileSync('index.html', html);
  console.log('✅ Site generated successfully.');
}

function generateIndexPage(projects) {
  // Collect all unique tags across all projects
  const allTags = [...new Set(
    projects.flatMap(p => (p.aiMeta?.tags && Array.isArray(p.aiMeta.tags)) ? p.aiMeta.tags : ['Outils'])
  )].sort();

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Projets - ${USERNAME}</title>
  <style>
    :root { --bg: #0d1117; --card-bg: #161b22; --border: #30363d; --text: #c9d1d9; --accent: #58a6ff; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; padding: 2rem; }
    h1 { text-align: center; margin-bottom: 2rem; color: var(--accent); }

    .filters { display: flex; justify-content: center; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 2rem; }
    .filter-btn { background: var(--card-bg); border: 1px solid var(--border); color: var(--text); padding: 0.4rem 1rem; border-radius: 20px; cursor: pointer; transition: all 0.2s; font-size: 0.9rem; }
    .filter-btn:hover, .filter-btn.active { background: var(--accent); color: white; border-color: var(--accent); }

    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 1.5rem; }

    .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 1.5rem; display: flex; flex-direction: column; gap: 0.75rem; transition: transform 0.2s, border-color 0.2s; }
    .card:hover { transform: translateY(-2px); border-color: var(--accent); }

    .card-header { display: flex; justify-content: space-between; align-items: start; gap: 1rem; }
    .card h2 { font-size: 1.1rem; margin: 0; }
    .card h2 a { color: var(--accent); text-decoration: none; }
    .card h2 a:hover { text-decoration: underline; }

    .badges { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 0.25rem; max-width: 45%; }
    .badge { font-size: 0.7rem; padding: 2px 7px; border-radius: 10px; white-space: nowrap; }
    .category-badge { background: #21262d; color: #8b949e; border: 1px solid #30363d; }
    .version-badge { background: #238636; color: white; }

    .description { color: #8b949e; font-size: 0.9rem; flex-grow: 1; }

    .actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
    .btn-secondary { background: transparent; border: 1px solid var(--border); color: var(--accent); text-decoration: none; padding: 0.4rem 0.9rem; border-radius: 6px; font-size: 0.85rem; text-align: center; transition: background 0.2s; }
    .btn-secondary:hover { background: rgba(88, 166, 255, 0.1); }
    .btn-download { background: #238636; color: white; text-decoration: none; padding: 0.4rem 0.9rem; border-radius: 6px; font-size: 0.85rem; text-align: center; transition: background 0.2s; }
    .btn-download:hover { background: #2ea043; }

    .meta { display: flex; gap: 1rem; font-size: 0.75rem; color: #6e7681; padding-top: 0.75rem; border-top: 1px solid var(--border); }

    footer { text-align: center; margin-top: 4rem; color: #6e7681; font-size: 0.8rem; }
  </style>
  <script>
    function filter(tag) {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      document.querySelector('button[data-cat="' + tag + '"]').classList.add('active');
      document.querySelectorAll('.card').forEach(card => {
        if (tag === 'All') {
          card.style.display = 'flex';
        } else {
          const tags = JSON.parse(card.dataset.tags || '[]');
          card.style.display = tags.includes(tag) ? 'flex' : 'none';
        }
      });
    }
  </script>
</head>
<body>
  <h1>🚀 Labo &amp; Projets</h1>

  <div class="filters">
    <button class="filter-btn active" data-cat="All" onclick="filter('All')">Tout</button>
    ${allTags.map(t => `<button class="filter-btn" data-cat="${t}" onclick="filter('${t}')">${t}</button>`).join('')}
  </div>

  <div class="grid">
    ${projects.map(p => buildCard(p.repo, p.latestRelease, p.aiMeta)).join('\n')}
  </div>

  <footer>
    Généré avec GitHub Actions · Dernière màj : ${new Date().toLocaleDateString('fr-FR')}
  </footer>
</body>
</html>`;
}

function generateBlogPage(repo, posts, aiMeta, latestReleaseUrl) {
  const tags = (aiMeta?.tags && Array.isArray(aiMeta.tags)) ? aiMeta.tags : ['Outils'];

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${repo.name} — Mises à jour</title>
  <style>
    :root { --bg: #0d1117; --card-bg: #161b22; --border: #30363d; --text: #c9d1d9; --accent: #58a6ff; }
    body { font-family: -apple-system, sans-serif; background: var(--bg); color: var(--text); max-width: 800px; margin: 0 auto; padding: 2rem; line-height: 1.7; }
    .back-link { color: #8b949e; text-decoration: none; font-size: 0.9rem; display: inline-block; margin-bottom: 2rem; }
    .back-link:hover { color: var(--accent); }
    header { margin-bottom: 2.5rem; padding-bottom: 1.5rem; border-bottom: 1px solid var(--border); }
    header h1 { color: var(--accent); margin-bottom: 0.5rem; }
    header p { color: #8b949e; }
    .tags { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-top: 0.75rem; }
    .tag { background: #21262d; color: #8b949e; border: 1px solid #30363d; font-size: 0.75rem; padding: 2px 8px; border-radius: 10px; }
    article { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 1.75rem; margin-bottom: 1.5rem; }
    .article-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 1rem; flex-wrap: wrap; gap: 0.5rem; }
    .article-header h2 { color: white; font-size: 1.1rem; }
    .date { font-size: 0.85rem; color: #8b949e; }
    .content { color: #c9d1d9; font-size: 0.95rem; }
    .content p { margin-bottom: 0.75rem; }
    .btn-download { display: inline-block; margin-top: 1.25rem; background: #238636; color: white; text-decoration: none; padding: 0.45rem 1rem; border-radius: 6px; font-size: 0.875rem; }
    .btn-download:hover { background: #2ea043; }
  </style>
</head>
<body>
  <a href="index.html" class="back-link">← Retour aux projets</a>
  <header>
    <h1>${repo.name}</h1>
    <p>${aiMeta?.description_fr || repo.description || ''}</p>
    <div class="tags">${tags.map(t => `<span class="tag">${t}</span>`).join('')}</div>
  </header>

  ${posts.map(post => `
  <article>
    <div class="article-header">
      <h2>Version ${post.version}</h2>
      <span class="date">${new Date(post.date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}</span>
    </div>
    <div class="content">${post.content}</div>
    ${latestReleaseUrl ? `<a href="${latestReleaseUrl}" class="btn-download" target="_blank">Télécharger la dernière version</a>` : ''}
  </article>`).join('')}
</body>
</html>`;
}

main().catch(console.error);
