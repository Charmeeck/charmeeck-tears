# Cloudflare Worker — Tears multi-streamer

Эта папка содержит общий сервер для всех стримеров. Не создавай отдельный Worker/D1 для каждого участника: один Worker обслуживает много аккаунтов DonationAlerts, каждый аккаунт изолирован по своему ID.

## Однократная настройка владельцем сервиса

Требуется Node.js LTS, npm и аккаунт Cloudflare.

1. Открой папку `worker` в терминале.
2. Выполни `npm install`.
3. Выполни `npx wrangler login` и подтверди вход в Cloudflare.
4. Создай одну базу D1: `npx wrangler d1 create tears-donations`.
5. Скопируй выданный `database_id` в `database_id` в `wrangler.toml`, вместо `PASTE_D1_DATABASE_ID_HERE`.
6. Примени схему: `npx wrangler d1 migrations apply tears-donations --remote`.
7. Убедись, что в `wrangler.toml` адреса Worker, GitHub Pages admin и widget соответствуют проекту.
8. Создай ОДНО OAuth-приложение DonationAlerts для всего сервиса. Redirect URI:
   `https://tears-donationalerts.charmwizard.workers.dev/oauth/callback`
   Права: `oauth-user-show` и `oauth-donation-subscribe`.
9. Добавь четыре секрета через Wrangler:
   - `npx wrangler secret put DA_CLIENT_ID`
   - `npx wrangler secret put DA_CLIENT_SECRET`
   - `npx wrangler secret put APP_ENCRYPTION_KEY`
   - `npx wrangler secret put INTERNAL_SECRET`
10. Опубликуй Worker: `npx wrangler deploy`.

Сгенерируй APP_ENCRYPTION_KEY:
`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`

Сгенерируй INTERNAL_SECRET:
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

Не публикуй значения секретов и не отправляй их стримерам. Переменные окружения с секретами задаются только в Cloudflare Worker Secrets.

## Что делает каждый новый стример

1. Открывает общую панель:
   `https://charmeeck.github.io/charmeeck-tears/admin.html`
2. Вводит стартовую сумму, цель и валюту.
3. Нажимает «Подключить DonationAlerts».
4. Авторизует свой аккаунт DonationAlerts и подтверждает доступ.
5. Копирует персональную ссылку OBS из панели.
6. Добавляет эту ссылку в OBS как Browser Source, размер 1774 × 887.

Другим стримерам не нужны GitHub, Cloudflare, D1, Wrangler, собственные Client ID/Secret или собственный OAuth-клиент.

## Изоляция и безопасность

- Один аккаунт DonationAlerts соответствует одной записи accounts.
- OAuth-токены хранятся зашифрованными в D1.
- Сессия панели хранится на сервере в виде SHA-256-хеша.
- Ключ Browser Source у каждого стримера уникальный и хранится в D1 зашифрованным; в OBS передаётся только его личная ссылка.
- События и история донатов имеют составной ключ (account_id, donation_id), поэтому дубли предотвращаются внутри аккаунта и не смешиваются с чужими.
- Для каждого аккаунта создаётся отдельный Durable Object и отдельная WebSocket-подписка.

## Проверка

Открой `https://tears-donationalerts.charmwizard.workers.dev/health`. Ответ должен содержать `"ok":true`. Затем подключи один тестовый аккаунт, открой его персональную ссылку в OBS и проверь небольшой тестовый донат.

Постоянный WebSocket в Durable Object расходует ресурсы Cloudflare. Проверяй Usage/Billing, особенно при росте числа одновременно подключённых стримеров.

## Автоматическое развёртывание

Cloudflare Workers Builds подключён к репозиторию `Charmeeck/charmeeck-tears`,
ветке `main` и корневой папке `/worker`. Новый коммит в этой папке запускает
команду `npx wrangler deploy`. Коммиты только в корне сайта не должны подменять
код Worker.
