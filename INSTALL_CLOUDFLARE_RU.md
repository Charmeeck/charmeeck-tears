# Tears v70 — подключение DonationAlerts для нескольких стримеров

**Это общий сервис.** Владелец проекта один раз настраивает GitHub Pages, Cloudflare Worker, D1 и одно OAuth-приложение DonationAlerts. После этого каждый новый стример просто авторизует свой аккаунт, задаёт суммы и забирает личную ссылку OBS.

## Однократная настройка владельцем сервиса

### 1. GitHub Pages

Сайт уже опубликован:

- Панель: https://charmeeck.github.io/charmeeck-tears/admin.html
- Виджет: https://charmeeck.github.io/charmeeck-tears/widget/

### 2. Создай одну D1 базу данных

В Cloudflare:
1. Открой Storage & databases → D1 SQL Database.
2. Нажми Create Database.
3. Имя: `tears-donations`.
4. Создай базу и скопируй её Database ID.
5. Вставь ID в `worker/wrangler.toml` вместо `PASTE_D1_DATABASE_ID_HERE`.

Загружать или создавать отдельную базу для каждого стримера не нужно.

### 3. Подготовь Wrangler

Установи Node.js LTS с https://nodejs.org/. В папке `worker` открой PowerShell и выполни:

```powershell
npm install
npx wrangler login
npx wrangler d1 migrations apply tears-donations --remote
```

### 4. Создай одно приложение DonationAlerts для всего сервиса

Открой https://www.donationalerts.com/application/clients и создай OAuth-приложение.

Redirect URI:
`https://tears-donationalerts.charmwizard.workers.dev/oauth/callback`

Права доступа:
- `oauth-user-show`
- `oauth-donation-subscribe`

Скопируй Client ID и Client Secret. **Это приложение создаётся один раз владельцем сервиса. Стримерам не нужно создавать собственные OAuth-приложения.**

### 5. Задай Worker Secrets

Из папки `worker` выполни:

```powershell
npx wrangler secret put DA_CLIENT_ID
npx wrangler secret put DA_CLIENT_SECRET
npx wrangler secret put APP_ENCRYPTION_KEY
npx wrangler secret put INTERNAL_SECRET
```

Введи значения Client ID/Secret из одного OAuth-приложения.

Сгенерируй APP_ENCRYPTION_KEY:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Сгенерируй INTERNAL_SECRET:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Каждое сгенерированное значение вставляй в соответствующую команду `wrangler secret put`. Не отправляй эти секреты другим стримерам и не записывай их в GitHub.

### 6. Опубликуй Worker

```powershell
npx wrangler deploy
```

Проверь:
`https://tears-donationalerts.charmwizard.workers.dev/health`

Ожидаемый ответ содержит `"ok":true`.

## Как подключается другой стример

Новый стример делает только это:

1. Открывает https://charmeeck.github.io/charmeeck-tears/admin.html
2. Вводит свою текущую сумму, цель и валюту.
3. Нажимает «Подключить DonationAlerts».
4. Входит в СВОЙ аккаунт DonationAlerts и подтверждает разрешения.
5. После возврата в панель проверяет суммы и копирует персональную ссылку OBS.
6. В OBS добавляет Источник → Браузер и вставляет ссылку. Размер: 1774 × 887.

Ему не нужно регистрировать GitHub или Cloudflare, создавать Worker или D1, загружать архив или вводить Client ID/Client Secret.

## Что разделяется между стримерами

- Аккаунт DonationAlerts и OAuth-токены.
- Начальная/текущая сумма, цель и валюта.
- История обработанных донатов.
- Live-подписка на канал событий.
- Персональная ссылка OBS и сессия управления.

Один стример не может использовать ключ виджета другого стримера для чтения его суммы или событий.

## Ограничения

Донат в валюте, отличной от валюты сбора, записывается в историю, но не прибавляется к прогрессу. Автоматической конвертации нет.

Каждый активный стример создаёт отдельный Durable Object с постоянной WebSocket-подпиской. Следи за Usage/Billing Cloudflare: бесплатный тариф не гарантирует бесплатную работу при любом числе активных стримеров.

Реальное поступление донатов ещё нужно проверить после настройки Cloudflare: подключить тестовый аккаунт, провести небольшой тестовый донат и убедиться, что изменилась сумма только у этого стримера.
