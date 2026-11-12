# Cloudflare Worker — «Слёзы»

Папка содержит серверную часть DonationAlerts. Она не публикует секреты в GitHub.

## Что требуется

- Node.js LTS;
- аккаунт Cloudflare;
- приложение DonationAlerts с Redirect URI `https://ИМЯ-WORKER.workers.dev/oauth/callback`.

## Быстрый запуск

Открой терминал в папке `worker`:

1. `npm install`
2. `npx wrangler login`
3. `npx wrangler d1 create tears-donations`
4. Скопируй `database_id` из ответа команды в `wrangler.toml`, заменив `PASTE_D1_DATABASE_ID_HERE`.
5. `npx wrangler d1 migrations apply tears-donations --remote`
6. Первый раз опубликуй Worker: `npx wrangler deploy`. Запомни адрес вида `https://tears-donationalerts.ТВОЙ-SUBDOMAIN.workers.dev`.
7. В `wrangler.toml` укажи этот адрес в `WORKER_BASE_URL`, затем снова выполни `npx wrangler deploy`.

## Секреты

В терминале, находясь в папке `worker`, задай секреты:

- `npx wrangler secret put ADMIN_PASSWORD`
- `npx wrangler secret put APP_ENCRYPTION_KEY`
- `npx wrangler secret put INTERNAL_SECRET`
- `npx wrangler secret put DA_CLIENT_ID`
- `npx wrangler secret put DA_CLIENT_SECRET`

Для генерации двух случайных значений используй Node.js:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Первая строка — значение `APP_ENCRYPTION_KEY`, вторая — `INTERNAL_SECRET`. Каждая команда `wrangler secret put` попросит вставить соответствующее значение. Не присылай эти значения в чат и не добавляй их в GitHub.

После добавления/обновления секретов выполни `npx wrangler deploy`.

## DonationAlerts

Создай OAuth-приложение в DonationAlerts. Redirect URI должен в точности совпадать с адресом Worker и путём `/oauth/callback`. Приложению нужны области доступа `oauth-user-show` и `oauth-donation-subscribe`. Client ID и Client Secret добавляются только через `wrangler secret put`.

## Проверка

Открой `/health` на адресе Worker. Ответ должен содержать `"ok":true`. Затем открой страницу `admin.html` на GitHub Pages, войди с `ADMIN_PASSWORD`, подключи DonationAlerts и сохрани сумму, цель и валюту.

Входящий WebSocket из Durable Object к DonationAlerts должен работать постоянно, поэтому следи за Usage/Billing Cloudflare. Не считай бесплатный тариф гарантированно бесплатным при непрерывной работе.
