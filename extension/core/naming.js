const LEVELS = ['few', 'balanced', 'many'];

const TOPICS = {
  code: ['开发与技术', '开发工具', '代码托管'],
  docs: ['开发与技术', '开发工具', '开发文档'],
  dev: ['开发与技术', '开发工具', '开发工具'],
  cloud: ['开发与技术', '云服务', '云与部署'],
  aiChat: ['AI 与工具', 'AI 工具', 'AI 对话'],
  aiCreate: ['AI 与工具', 'AI 工具', 'AI 创作'],
  aiDev: ['AI 与工具', 'AI 工具', 'AI 开发'],
  design: ['AI 与工具', '设计创作', '设计资源'],
  course: ['学习与资料', '学习资料', '在线课程'],
  knowledge: ['学习与资料', '学习资料', '知识资料'],
  video: ['生活与娱乐', '影音娱乐', '视频'],
  music: ['生活与娱乐', '影音娱乐', '音乐'],
  news: ['学习与资料', '资讯阅读', '资讯'],
  shopping: ['生活与娱乐', '生活服务', '购物'],
  gov: ['工作与服务', '生活服务', '政务与考试'],
  office: ['工作与服务', '效率办公', '办公协作'],
};

// Exact domains and their subdomains are safe to recognize; arbitrary substrings are not.
const SITES = [
  ['cloud.tencent.com', '腾讯云', 'cloud'], ['developer.mozilla.org', 'MDN', 'docs'],
  ['docs.github.com', 'GitHub 文档', 'docs'], ['docs.google.com', 'Google 文档', 'office'],
  ['github.com', 'GitHub', 'code'], ['gitlab.com', 'GitLab', 'code'], ['gitee.com', 'Gitee', 'code'],
  ['stackoverflow.com', 'Stack Overflow', 'dev'], ['npmjs.com', 'npm', 'dev'],
  ['react.dev', 'React', 'docs'], ['vuejs.org', 'Vue', 'docs'], ['nodejs.org', 'Node.js', 'docs'],
  ['typescriptlang.org', 'TypeScript', 'docs'], ['python.org', 'Python', 'docs'],
  ['aliyun.com', '阿里云', 'cloud'], ['vercel.com', 'Vercel', 'cloud'], ['netlify.com', 'Netlify', 'cloud'],
  ['aws.amazon.com', 'AWS', 'cloud'], ['cloud.google.com', 'Google Cloud', 'cloud'],
  ['chatgpt.com', 'ChatGPT', 'aiChat'], ['chat.openai.com', 'ChatGPT', 'aiChat'], ['claude.ai', 'Claude', 'aiChat'],
  ['gemini.google.com', 'Gemini', 'aiChat'], ['deepseek.com', 'DeepSeek', 'aiChat'], ['grok.com', 'Grok', 'aiChat'],
  ['huggingface.co', 'Hugging Face', 'aiDev'], ['platform.openai.com', 'OpenAI 开发平台', 'aiDev'],
  ['midjourney.com', 'Midjourney', 'aiCreate'], ['suno.com', 'Suno', 'aiCreate'],
  ['figma.com', 'Figma', 'design'], ['canva.com', 'Canva', 'design'], ['dribbble.com', 'Dribbble', 'design'],
  ['coursera.org', 'Coursera', 'course'], ['udemy.com', 'Udemy', 'course'], ['icourse163.org', '中国大学 MOOC', 'course'],
  ['wikipedia.org', 'Wikipedia', 'knowledge'], ['zhihu.com', '知乎', 'knowledge'],
  ['youtube.com', 'YouTube', 'video'], ['youtu.be', 'YouTube', 'video'], ['bilibili.com', '哔哩哔哩', 'video'],
  ['music.163.com', '网易云音乐', 'music'], ['spotify.com', 'Spotify', 'music'], ['y.qq.com', 'QQ 音乐', 'music'],
  ['taobao.com', '淘宝', 'shopping'], ['jd.com', '京东', 'shopping'],
  ['notion.so', 'Notion', 'office'], ['notion.site', 'Notion', 'office'], ['feishu.cn', '飞书', 'office'],
  ['36kr.com', '36氪', 'news'], ['sspai.com', '少数派', 'news'], ['ithome.com', 'IT之家', 'news'],
];

export function matchesDomain(hostname, domain) {
  const host = hostname.toLowerCase().replace(/\.$/u, '');
  return host === domain || host.endsWith(`.${domain}`);
}

function parsedWebUrl(url) {
  try {
    const parsed = new URL(url);
    return ['https:', 'http:'].includes(parsed.protocol) ? parsed : null;
  } catch { return null; }
}

function siteFor(parsed) {
  return parsed && SITES.find(([domain]) => matchesDomain(parsed.hostname, domain));
}

const GENERIC_HOME_TITLES = {
  'GitHub': /^(?:GitHub\s*[·|–—-]\s*(?:Build and ship software|Let[’']s build from here)|GitHub: Let[’']s build from here)$/iu,
  'ChatGPT': /^ChatGPT\s*[·|–—-]\s*AI\s*对话$/iu,
  'Notion': /^Notion\s*[·|–—-]\s*工作空间$/iu,
  '腾讯云': /^腾讯云\s*[·|–—-]\s*产业智变\s*云启未来$/u,
  '阿里云': /^阿里云\s*[·|–—-]\s*(?:计算，为了无法计算的价值|云计算服务)$/u,
};

const BRAND_PREFIX_ALIASES = { MDN: ['MDN Web Docs', 'MDN'] };

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function compactBrandPrefix(title, name) {
  for (const alias of BRAND_PREFIX_ALIASES[name] ?? [name]) {
    const match = title.match(new RegExp(`^${escapeRegex(alias)}\\s*(?:\\||-|–|—|·)\\s*(.+)$`, 'iu'));
    if (match?.[1].trim()) return `${name}·${match[1].trim()}`;
  }
  return title;
}

function retainValidSuggestion(original, suggestion) {
  // Existing long or empty titles are valid user data; never truncate page topics.
  return suggestion.length === 0 || suggestion.length > 200 ? original : suggestion;
}

export function suggestTitle({ title, url }) {
  const original = String(title ?? '');
  const cleaned = original.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
  const parsed = parsedWebUrl(url);
  const site = siteFor(parsed);
  if (!site) return retainValidSuggestion(original, cleaned);
  const name = site[1];
  const withoutSuffix = cleaned.replace(new RegExp(`\\s+(?:\\||-|–|—|·)\\s*${escapeRegex(name)}$`, 'iu'), '').trim() || cleaned;
  const exactHost = parsed.hostname.toLowerCase() === site[0] || parsed.hostname.toLowerCase() === `www.${site[0]}`;
  const genericTitle = withoutSuffix.toLowerCase() === name.toLowerCase() || GENERIC_HOME_TITLES[name]?.test(withoutSuffix);
  // A product subdomain or customized topic must not be reduced to its parent brand.
  if (exactHost && genericTitle && (parsed.pathname === '/' || parsed.pathname === '') && !parsed.search && !parsed.hash) return name;
  return retainValidSuggestion(original, compactBrandPrefix(withoutSuffix, name));
}

export function categoryCatalog(granularity = 'balanced') {
  const level = LEVELS.indexOf(granularity);
  if (level === -1) throw new TypeError('分类粒度 granularity 无效');
  return [...new Set(Object.values(TOPICS).map((categories) => categories[level]))];
}

const KEYWORDS = [
  ['gov', /事业单位|公务员|考试公告|招考|报名|政务|政府|社保|公积金/u, /(?:civil service|government|recruitment exam)/iu],
  ['aiCreate', /图像生成|图片生成|音乐生成|文生图|文生视频|AI\s*绘画/iu, /(?:image generation|text to image|ai art)/iu],
  ['aiDev', /大模型|模型训练|机器学习|提示词|智能体/u, /(?:^|[^a-z0-9])(?:llm|machine learning|prompt|agents?)(?:[^a-z0-9]|$)/iu],
  ['aiChat', /人工智能|AI\s*工具|AI\s*对话/iu, /(?:^|[^a-z0-9])(?:chatgpt|claude|deepseek|gemini|chatbot|ai)(?:[^a-z0-9]|$)/iu],
  ['docs', /开发文档|接口文档|编程教程|代码参考/u, /(?:^|[^a-z0-9])(?:javascript|typescript|react|vue|python|api reference|developer docs)(?:[^a-z0-9]|$)/iu],
  ['dev', /代码|编程|开发工具|程序设计/u, /(?:^|[^a-z0-9])(?:programming|coding|developer tools|source code)(?:[^a-z0-9]|$)/iu],
  ['cloud', /云服务|云服务器|域名|部署|主机/u, /(?:^|[^a-z0-9])(?:hosting|deployment|cloud server|dns)(?:[^a-z0-9]|$)/iu],
  ['design', /设计素材|图标|字体|配色|设计资源/u, /(?:^|[^a-z0-9])(?:design|icons|fonts|color palette)(?:[^a-z0-9]|$)/iu],
  ['course', /在线课程|网课|公开课|学习课程/u, /(?:^|[^a-z0-9])(?:course|tutorial|online learning)(?:[^a-z0-9]|$)/iu],
  ['video', /视频|电影|纪录片|番剧/u, /(?:^|[^a-z0-9])(?:video|movie|documentary)(?:[^a-z0-9]|$)/iu],
  ['music', /音乐|歌曲|歌单/u, /(?:^|[^a-z0-9])(?:music|playlist|songs)(?:[^a-z0-9]|$)/iu],
  ['news', /新闻|资讯|日报/u, /(?:^|[^a-z0-9])(?:news|newsletter)(?:[^a-z0-9]|$)/iu],
  ['shopping', /购物|商城|商品/u, /(?:^|[^a-z0-9])(?:shopping|store|product catalog)(?:[^a-z0-9]|$)/iu],
  ['office', /办公|协作|日历|任务管理/u, /(?:^|[^a-z0-9])(?:calendar|task management|collaboration)(?:[^a-z0-9]|$)/iu],
];

export function classifyBookmark({ title, url }, granularity = 'balanced') {
  const level = LEVELS.indexOf(granularity);
  if (level === -1) throw new TypeError('分类粒度 granularity 无效');
  const parsed = parsedWebUrl(url);
  if (!parsed) return { category: null, confidence: 'review', reason: '无法确认页面用途，保留当前位置' };
  const site = siteFor(parsed);
  let topic = site?.[2];
  let reason = site ? '已知网站用途' : '';
  if (!topic && matchesDomain(parsed.hostname, 'gov.cn')) { topic = 'gov'; reason = '政务网站域名'; }
  if (!topic) {
    const keyword = KEYWORDS.find(([, chinese, english]) => chinese.test(title ?? '') || english.test(title ?? ''));
    if (keyword) { topic = keyword[0]; reason = '标题包含明确用途关键词'; }
  }
  if (!topic) {
    let path = parsed.pathname;
    try { path = decodeURIComponent(path); } catch { /* Keep the literal path for malformed escapes. */ }
    if (/(?:^|\/)(?:docs?|documentation|reference|api)(?:\/|$)/iu.test(path)) topic = 'docs';
    else if (/(?:^|\/)(?:courses?|tutorials?|learn)(?:\/|$)/iu.test(path)) topic = 'course';
    if (topic) reason = '网址路径包含明确用途线索';
  }
  if (!topic) return { category: null, confidence: 'review', reason: '无法确认页面用途，保留当前位置' };
  return { category: TOPICS[topic][level], confidence: 'high', reason };
}

const FOLDER_ALIASES = {
  '开发': ['开发与技术', '开发工具', '代码托管', '开发文档'],
  '编程': ['开发与技术', '开发工具', '代码托管', '开发文档'],
  '开发工具': ['开发与技术', '开发工具', '代码托管', '开发文档'],
  'AI': ['AI 与工具', 'AI 工具', 'AI 对话', 'AI 创作', 'AI 开发'],
  'AI 工具': ['AI 与工具', 'AI 工具', 'AI 对话', 'AI 创作', 'AI 开发'],
  '人工智能': ['AI 与工具', 'AI 工具', 'AI 对话', 'AI 创作', 'AI 开发'],
  '云服务': ['云服务', '云与部署'],
  '学习': ['学习与资料', '学习资料', '在线课程', '知识资料'],
  '影音': ['生活与娱乐', '影音娱乐', '视频', '音乐'],
  '办公': ['工作与服务', '效率办公', '办公协作'],
};

export function matchesCategoryFolder(title, category) {
  const normalized = title.trim();
  if (normalized.toLowerCase() === category.toLowerCase()) return true;
  const alias = Object.entries(FOLDER_ALIASES).find(([name]) => name.toLowerCase() === normalized.toLowerCase());
  return Boolean(alias?.[1].includes(category));
}
