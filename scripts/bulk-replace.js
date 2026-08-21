const fs = require('fs');
const path = require('path');

const dirs = [
  '/Volumes/Work/CY/structured/cy-new/webview/assets',
  '/Volumes/Work/CY/structured/cy-new/out'
];

const replacements = [
  { from: /OpenAI/g, to: 'SYMBIOTYC' },
  { from: /ChatGPT/g, to: 'CY' },
  { from: /chatgpt/gi, to: 'cy' },
  { from: /openai\.chatgpt/gi, to: 'symbiotyc.cy-ide' },
  { from: /openai-chatgpt/gi, to: 'symbiotyc-cy-ide' },
  { from: /Упс, произошла ошибка/gi, to: 'Что-то пошло не так' },
  { from: /Упс, дошло је до грешке/gi, to: 'Нешто је пошло најавно' },
  { from: /Упс, се појави грешка/gi, to: 'Се случи неочекувана грешка' },
  { from: /Архивировать чат/gi, to: 'Удалить чат' },
  { from: /Новый чат/gi, to: 'Переименовать чат' },
  { from: /Создавайте быстрее/gi, to: 'Создавайте с CY' },
  { from: /Oops, something went wrong/gi, to: 'Что-то пошло не так' },
  { from: /Archive chat/gi, to: 'Удалить чат' },
  { from: /New chat/gi, to: 'Переименовать чат' },
  { from: /Build faster with/gi, to: 'Build with' },
  { from: /codex-app/gi, to: 'cy-ide' },
  { from: /codex-micro/gi, to: 'cy-micro' },
  { from: /codex-home/gi, to: 'cy-home' },
  { from: /codex-local/gi, to: 'cy-local' },
  { from: /codex-dark/gi, to: 'cy-dark' },
  { from: /codex-light/gi, to: 'cy-light' },
  { from: /codex-rules/gi, to: 'cy-rules' },
  { from: /developers\.openai\.com/gi, to: 'symbiotyc.dev' },
  { from: /platform\.openai\.com/gi, to: 'symbiotyc.workers.dev' },
  { from: /openai\.com/gi, to: 'symbiotyc.workers.dev' },
  { from: /api\.openai\.com/gi, to: 'symbiotyc.workers.dev' },
  { from: /auth0\.openai\.com/gi, to: 'auth.symbiotyc.workers.dev' },
  { from: /chat\.openai\.com/gi, to: 'chat.symbiotyc.workers.dev' },
  { from: /blossom\.dark\.png/gi, to: 'cy-logo.png' },
  { from: /blossom-black\.svg/gi, to: 'cy-logo-b.png' },
  { from: /blossom-white\.svg/gi, to: 'cy-logo-w.png' },
  { from: /Приложение CY/gi, to: 'CY - VIBE IDE.' },
  { from: /Создавайте быстрее с приложением CY/gi, to: 'CY - VIBE IDE.' },
  { from: /Скачайте сейчас или узнать больше/gi, to: 'Сайт Symbiotyc' },
  { from: /Download now or learn more/gi, to: 'Visit Symbiotyc' },
  { from: /ChatGPT Plus/gi, to: 'CY Pro' },
  { from: /ChatGPT Enterprise/gi, to: 'CY Enterprise' },
  { from: /ChatGPT Team/gi, to: 'CY Team' },
  { from: /gpt-4/gi, to: 'cy-i1a' },
  { from: /gpt-4o/gi, to: 'cy-i1a' },
  { from: /gpt-3/gi, to: 'cy-legacy' },
  { from: /cx Micro/gi, to: 'CY Micro' },
  { from: /cx Agent/gi, to: 'CY Agent' },
  { from: /cx Desktop/gi, to: 'CY Desktop' },
  { from: /cx CLI/gi, to: 'CY CLI' },
  { from: /cx Apps/gi, to: 'CY Apps' },
  { from: /cx <noreply@auth\.symbiotyc\.workers\.dev>/gi, to: 'CY <noreply@auth.symbiotyc.workers.dev>' },
  { from: /dall-e/gi, to: 'cy-image' },
  { from: /whisper/gi, to: 'cy-audio' },
  { from: /openai\.com\/images/gi, to: 'symbiotyc.workers.dev/images' },
  // Додаткові заміни для повного брендингу CY
  { from: /cx IDE/gi, to: 'CY IDE' },
  { from: /cx IDE\./gi, to: 'CY IDE.' },
  { from: /cx IDE\b/gi, to: 'CY IDE' },
  { from: /cx\s+IDE/gi, to: 'CY IDE' },
  { from: /cx <noreply@auth\.cx>/gi, to: 'CY <noreply@auth.symbiotyc.workers.dev>' },
  { from: /noreply@auth\.cx/gi, to: 'noreply@auth.symbiotyc.workers.dev' },
  { from: /https:\/\/cy\.com/gi, to: 'https://cy.symbiotyc.workers.dev/v1' },
  { from: /\/codex\/desktop-auth/gi, to: '/v1/account/login/start' },
  // Заміни для автентифікації
  { from: /chatgptDeviceCode/gi, to: 'cyDeviceCode' },
  { from: /chatgptAuthTokens/gi, to: 'cyAuthTokens' },
  { from: /amazonBedrock/gi, to: 'cyBedrock' },
  { from: /apiKey, chatgpt, chatgptDeviceCode, chatgptAuthTokens, amazonBedrock/gi, to: 'apiKey, cy, cyDeviceCode, cyAuthTokens, cyBedrock' },
  { from: /apiKey\|chatgpt\|chatgptDeviceCode\|chatgptAuthTokens\|amazonBedrock/gi, to: 'apiKey|cy|cyDeviceCode|cyAuthTokens|cyBedrock' },
  // Заміни для type полів
  { from: /"type":\s*"chatgpt"/gi, to: '"type": "cy"' },
  { from: /'type':\s*'chatgpt'/gi, to: "'type': 'cy'" },
  { from: /type:\s*'chatgpt'/gi, to: "type: 'cy'" },
  { from: /type:\s*"chatgpt"/gi, to: 'type: "cy"' },
  // Заміни для авторизаційних URL
  { from: /account\/login\/start.*chatgpt/gi, to: 'account/login/start?type=cy' },
  { from: /account\/login\/start.*type=chatgpt/gi, to: 'account/login/start?type=cy' },
  { from: /account\/login\/start.*type=chatgptDeviceCode/gi, to: 'account/login/start?type=cyDeviceCode' },
];

let totalFiles = 0;
let changedFiles = 0;

for (const dir of dirs) {
  if (!fs.existsSync(dir)) continue;
  const files = fs.readdirSync(dir);
  for (const file of files) {
    if (!file.endsWith('.js') && !file.endsWith('.js.map') && !file.endsWith('.mjs') && !file.endsWith('.css')) continue;
    const filePath = path.join(dir, file);
    totalFiles++;
    let content = fs.readFileSync(filePath, 'utf8');
    let original = content;
    for (const rule of replacements) {
      content = content.replace(rule.from, rule.to);
    }
    if (content !== original) {
      fs.writeFileSync(filePath, content, 'utf8');
      changedFiles++;
      console.log(`Updated: ${filePath}`);
    }
  }
}

console.log(`\nTotal files scanned: ${totalFiles}`);
console.log(`Files changed: ${changedFiles}`);
