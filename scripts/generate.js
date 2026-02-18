const fs = require('fs');
const path = require('path');

const USERNAME = 'guilamu';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const POE_API_KEY = process.env.POE_API_KEY;
const CACHE_FILE = 'ai_cache.json';

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
      body: JSON.stringify({
        model: model,
        messages: messages,
        temperature: 0.7
      })
    });

    if (!response.ok) {
        const err = await response.text();
        console.error(`POE API Error: ${response.status}`, err);
        return null; // Fail gracefully
    }

    const data = await response.json();
    return data.choices[0].message.content;
  } catch (error) {
    console.error('POE API Request Failed:', error);
    return null;
  }
}

async function getLatestSonnetModel() {
    if (!POE_API_KEY) return 'gpt-4o'; // Fallback for testing without key

    try {
        const response = await fetch('https://api.poe.com/v1/models', {
            headers: { 'Authorization': `Bearer ${POE_API_KEY}` }
        });
        if (!response.ok) throw new Error('Failed to fetch models');
        
        const data = await response.json();
        const sonnetModels = data.data
            .filter(m => m.metadata && m.metadata.display_name && m.metadata.display_name.includes('Claude') && m.metadata.display_name.includes('Sonnet'))
            .sort((a, b) => b.metadata.display_name.localeCompare(a.metadata.display_name, undefined, { numeric: true, sensitivity: 'base' }));

        if (sonnetModels.length > 0) {
            console.log(`🤖 Using model: ${sonnetModels[0].metadata.display_name} (${sonnetModels[0].id})`);
            return sonnetModels[0].id;
        }
    } catch (e) {
        console.error('Error fetching models:', e);
    }
    return 'Claude-3.5-Sonnet'; // Fallback known ID
}


// --- CACHE ---

function loadCache() {
  if (fs.existsSync(CACHE_FILE)) {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  }
  return {};
}

function saveCache(cache) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

// --- GENERATION AI ---

async function getProjectMetadata(repo, model, cache) {
    const cacheKey = `meta_${repo.id}`;
    if (cache[cacheKey]) return cache[cacheKey];

    console.log(`🧠 Generating metadata for ${repo.name}...`);
    const prompt = `
    Projet: ${repo.name}
    Description actuelle: ${repo.description || "Aucune"}
    Langage: ${repo.language}
    
    Tâche:
    1. Catégorise ce projet dans UNE SEULE de ces catégories : "Gravity Forms", "IA", "Wordpress", "Outils", "Données".
    2. Rédige une très courte description (max 20 mots) en français, accrocheuse.
    
    Format de réponse attendu (JSON uniquement):
    {
      "category": "Catégorie choisie",
      "description_fr": "Description générée"
    }
    `;

    const content = await poeApiCall(model, [{ role: 'user', content: prompt }]);
    if (!content) return { category: 'Outils', description_fr: repo.description };

    try {
        // Nettoyage basique poour extraire le JSON si le modèle est bavard
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        const json = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(content);
        cache[cacheKey] = json;
        return json;
    } catch (e) {
        console.error('Error parsing AI JSON:', e);
        return { category: 'Outils', description_fr: repo.description };
    }
}

async function getReleasePost(repo, release, model, cache) {
    const cacheKey = `post_${release.id}`;
    if (cache[cacheKey]) return cache[cacheKey];

    console.log(`✍️ Writing blog post for ${repo.name} ${release.tag_name}...`);
    const prompt = `
    Tu es un rédacteur technique. Rédige un court post de blog (HTML sans header/body, juste le contenu) en français annonçant la mise à jour ${release.tag_name} du projet "${repo.name}".
    
    Changelog original:
    ${release.body}
    
    Consignes:
    - Ton enthousiaste et professionnel.
    - Met en avant les points clés.
    - Utilise des émojis.
    - Reste concis (env. 100-150 mots).
    `;

    const content = await poeApiCall(model, [{ role: 'user', content: prompt }]);
    if (content) {
        cache[cacheKey] = content;
        return content;
    }
    return null;
}

// --- HTML GENERATORS ---

function buildCard(repo, release, aiMeta) {
  const version = release ? release.tag_name : null;
  const categoryClass = aiMeta.category.toLowerCase().replace(/\s/g, '-');
  
  return `
  <div class="card" data-category="${aiMeta.category}">
    <div class="card-header">
      <h2><a href="${repo.html_url}" target="_blank">${repo.name}</a></h2>
      <div class="badges">
        <span class="badge category-badge">${aiMeta.category}</span>
        ${version ? `<span class="badge version-badge">${version}</span>` : ''}
      </div>
    </div>
    <p class="description">${aiMeta.description_fr || repo.description || 'Projet personnel'}</p>
    <div class="actions">
       ${release ? `<a href="blog-${repo.name}.html" class="btn-secondary">📰 Voir les mises à jour</a>` : ''}
    </div>
    <div class="meta">
      <span>⭐ ${repo.stargazers_count}</span>
      ${repo.language ? `<span>🔧 ${repo.language}</span>` : ''}
    </div>
  </div>`;
}

// --- MAIN ---

async function main() {
  const cache = loadCache();
  const model = await getLatestSonnetModel();
  
  console.log('📥 Fetching repositories...');
  // Fetch all repos
  let repos = await apiGet(`/users/${USERNAME}/repos?type=public&per_page=100&sort=updated`);
  repos = repos.filter(r => !r.fork);

  const projects = [];

  for (const repo of repos) {
    console.log(`Processing ${repo.name}...`);
    
    // 1. Get Releases
    let releases = [];
    try {
        releases = await apiGet(`/repos/${USERNAME}/${repo.name}/releases?per_page=20`);
    } catch (e) {
        // No releases or error
    }

    // 2. Get AI Metadata
    const aiMeta = await getProjectMetadata(repo, model, cache);

    // 3. Generate Blog Posts for releases
    const blogPosts = [];
    for (const release of releases) {
        const postContent = await getReleasePost(repo, release, model, cache);
        if (postContent) {
            blogPosts.push({
                version: release.tag_name,
                date: release.published_at,
                content: postContent,
                downloadUrl: release.zipball_url
            });
        }
    }
    
    // Create Blog Page if posts exist
    if (blogPosts.length > 0) {
        const blogHtml = generateBlogPage(repo, blogPosts, aiMeta);
        fs.writeFileSync(`blog-${repo.name}.html`, blogHtml);
    }

    const latestRelease = releases.length > 0 ? releases[0] : null;
    projects.push({ repo, latestRelease, aiMeta });
  }

  saveCache(cache); // Persist cache

  // Generate Main Index
  const html = generateIndexPage(projects);
  fs.writeFileSync('index.html', html);
  console.log('✅ Site and blogs generated successfully.');
}

function generateIndexPage(projects) {
    const categories = [...new Set(projects.map(p => p.aiMeta.category))].sort();
    
    return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Activités & Projets - ${USERNAME}</title>
  <style>
    :root { --bg: #0d1117; --card-bg: #161b22; --border: #30363d; --text: #c9d1d9; --accent: #58a6ff; --badge-bg: #1f6feb; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; padding: 2rem; }
    h1 { text-align: center; margin-bottom: 2rem; color: var(--accent); }
    
    /* Filters */
    .filters { display: flex; justify-content: center; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 2rem; }
    .filter-btn { background: var(--card-bg); border: 1px solid var(--border); color: var(--text); padding: 0.5rem 1rem; border-radius: 20px; cursor: pointer; transition: all 0.2s; }
    .filter-btn:hover, .filter-btn.active { background: var(--accent); color: white; border-color: var(--accent); }
    
    /* Grid */
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(350px, 1fr)); gap: 1.5rem; }
    
    /* Card */
    .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 1.5rem; display: flex; flex-direction: column; gap: 1rem; transition: transform 0.2s; }
    .card:hover { transform: translateY(-2px); border-color: var(--accent); }
    
    .card-header { display: flex; justify-content: space-between; align-items: start; gap: 1rem; }
    .card h2 { font-size: 1.25rem; margin: 0; }
    .card h2 a { color: var(--accent); text-decoration: none; }
    .card h2 a:hover { text-decoration: underline; }
    
    .badges { display: flex; flex-direction: column; align-items: flex-end; gap: 0.25rem; }
    .badge { font-size: 0.75rem; padding: 2px 8px; border-radius: 10px; white-space: nowrap; }
    .category-badge { background: #30363d; color: #8b949e; border: 1px solid #6e7681; }
    .version-badge { background: #238636; color: white; }
    
    .description { color: #8b949e; font-size: 0.95rem; flex-grow: 1; }
    
    .actions { display: flex; gap: 0.5rem; margin-top: auto; }
    .btn-secondary { background: transparent; border: 1px solid var(--border); color: var(--accent); text-decoration: none; padding: 0.5rem 1rem; border-radius: 6px; font-size: 0.9rem; width: 100%; text-align: center; transition: background 0.2s; }
    .btn-secondary:hover { background: rgba(88, 166, 255, 0.1); }
    
    .meta { display: flex; justify-content: space-between; font-size: 0.8rem; color: #6e7681; padding-top: 1rem; border-top: 1px solid var(--border); margin-top: 1rem; }
    
    footer { text-align: center; margin-top: 4rem; color: #6e7681; font-size: 0.8rem; }
  </style>
  <script>
    function filter(category) {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        document.querySelector(\`button[data-cat="\${category}"]\`).classList.add('active');
        
        const cards = document.querySelectorAll('.card');
        cards.forEach(card => {
            if (category === 'All' || card.dataset.category === category) {
                card.style.display = 'flex';
            } else {
                card.style.display = 'none';
            }
        });
    }
  </script>
</head>
<body>
  <h1>🚀 Labo & Projets</h1>
  
  <div class="filters">
    <button class="filter-btn active" data-cat="All" onclick="filter('All')">Tout</button>
    ${categories.map(c => `<button class="filter-btn" data-cat="${c}" onclick="filter('${c}')">${c}</button>`).join('')}
  </div>

  <div class="grid">
    ${projects.map(p => buildCard(p.repo, p.latestRelease, p.aiMeta)).join('\n')}
  </div>

  <footer>
    Généré avec ❤️ par une IA (Claude Sonnet) et GitHub Actions.<br>
    Dernière màj: ${new Date().toLocaleDateString('fr-FR')}
  </footer>
</body>
</html>`;
}

function generateBlogPage(repo, posts, aiMeta) {
    return `<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Blog - ${repo.name}</title>
    <style>
        :root { --bg: #0d1117; --card-bg: #161b22; --border: #30363d; --text: #c9d1d9; --accent: #58a6ff; }
        body { font-family: -apple-system, sans-serif; background: var(--bg); color: var(--text); max-width: 800px; margin: 0 auto; padding: 2rem; line-height: 1.6; }
        header { margin-bottom: 3rem; border-bottom: 1px solid var(--border); padding-bottom: 2rem; }
        h1 { color: var(--accent); margin-bottom: 0.5rem; }
        .back-link { color: var(--text); text-decoration: none; opacity: 0.7; font-size: 0.9rem; }
        .back-link:hover { opacity: 1; text-decoration: underline; }
        
        article { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 2rem; margin-bottom: 2rem; }
        article h2 { color: white; margin-bottom: 0.5rem; display: flex; justify-content: space-between; align-items: center; }
        .date { font-size: 0.85rem; color: #8b949e; font-weight: normal; }
        .content { margin-top: 1.5rem; }
        .content ul { padding-left: 1.5rem; }
        .download-btn { display: inline-block; margin-top: 1.5rem; background: #238636; color: white; text-decoration: none; padding: 0.5rem 1rem; border-radius: 6px; font-size: 0.9rem; }
        .download-btn:hover { background: #2ea043; }
    </style>
</head>
<body>
    <a href="index.html" class="back-link">← Retour aux projets</a>
    <header>
        <h1>${repo.name}</h1>
        <p>${aiMeta.description_fr}</p>
        <span style="background: #30363d; padding: 2px 8px; border-radius: 10px; font-size: 0.8rem; margin-top: 10px; display: inline-block;">${aiMeta.category}</span>
    </header>

    ${posts.map(post => `
    <article>
        <h2>
            Version ${post.version}
            <span class="date">${new Date(post.date).toLocaleDateString('fr-FR', {day: 'numeric', month: 'long', year: 'numeric'})}</span>
        </h2>
        <div class="content">
            ${post.content}
        </div>
        ${post.downloadUrl ? `<a href="${post.downloadUrl}" class="download-btn">⬇ Télécharger le code source</a>` : ''}
    </article>
    `).join('')}
</body>
</html>`;
}

main().catch(console.error);
