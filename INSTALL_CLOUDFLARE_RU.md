# Подключение «Слёз» к DonationAlerts через GitHub Pages и Cloudflare

Эта инструкция для репозитория `Charmeeck/charmeeck-tears`. Beget и PHP не нужны.

## 1. Сначала опубликуй сайт

После слияния ветки интеграции в `main` GitHub Pages опубликует:
- главную: `https://charmeeck.github.io/charmeeck-tears/`
- панель: `https://charmeeck.github.io/charmeeck-tears/admin.html`
- виджет: `https://charmeeck.github.io/charmeeck-tears/widget/`

В OBS Browser Source укажи адрес виджета, размер 1774 × 887. Пока Cloudflare Worker не настроен, виджет остаётся демонстрационным.

## 2. Установи Node.js

Скачай Node.js LTS с официального сайта https://nodejs.org/ и установи с настройками по умолчанию. После установки открой PowerShell и выполни:

```powershell
node -v
npm -v
```

Обе команды должны вывести номера версий.

## 3. Подготовь Cloudflare Worker

На компьютере открой папку репозитория, затем папку `worker`. В адресной строке Проводника напиши `powershell` и нажми Enter — откроется терминал сразу в нужной папке.

Выполни команды по одной:

```powershell
npm install
npx wrangler login
```

Откроется браузер Cloudflare. Войди в аккаунт и разреши Wrangler доступ.

Создай базу данных:

```powershell
npx wrangler d1 create tears-donations
```

В ответе найди `database_id`. Открой файл `worker/wrangler.toml` в редакторе и замени значение `PASTE_D1_DATABASE_ID_HERE` на свой ID. Не меняй название базы и привязку `DB`.

Примени таблицы базы:

```powershell
npx wrangler d1 migrations apply tears-donations --remote
```

## 4. Опубликуй Worker первый раз

В папке `worker` выполни:

```powershell
npx wrangler deploy
```

В конце появится адрес примерно такого вида:

`https://tears-donationalerts.ТВОЙ-SUBDOMAIN.workers.dev`

Скопируй именно свой адрес. В `worker/wrangler.toml` замени:
- `REPLACE-WITH-YOUR-WORKER.workers.dev` в `WORKER_BASE_URL` на свой адрес;
- не меняй `ALLOWED_ORIGIN = "https://charmeeck.github.io"`;
- не меняй `ADMIN_PAGE_URL = "https://charmeeck.github.io/charmeeck-tears/admin.html"`.

В корневом файле репозитория `config.js` замени адрес-заглушку на тот же адрес Worker:

`window.TEARS_DA_WORKER = 'https://твой-адрес.workers.dev';`

Сохрани оба файла, отправь их в GitHub (commit/push), затем снова выполни `npx wrangler deploy`.

## 5. Создай секреты Worker

Всё ещё находясь в папке `worker`, по очереди выполни:

```powershell
npx wrangler secret put ADMIN_PASSWORD
```

Введи придуманный длинный пароль панели. Сохрани его у себя в менеджере паролей.

Сгенерируй ключ шифрования:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Скопируй выведенную строку, затем выполни `npx wrangler secret put APP_ENCRYPTION_KEY` и вставь её.

Сгенерируй внутренний секрет:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Скопируй строку, затем выполни `npx wrangler secret put INTERNAL_SECRET` и вставь её.

Не публикуй эти значения, не присылай их в чат и не записывай в `wrangler.toml` или `config.js`.

## 6. Создай приложение DonationAlerts

Открой https://www.donationalerts.com/application/clients и создай OAuth-приложение.

В поле Redirect URI укажи точный адрес:

`https://ТВОЙ-WORKER.workers.dev/oauth/callback`

Сохрани Client ID и Client Secret. Добавь их в Worker только через команды:

```powershell
npx wrangler secret put DA_CLIENT_ID
npx wrangler secret put DA_CLIENT_SECRET
```

После добавления всех секретов выполни:

```powershell
npx wrangler deploy
```

## 7. Подключи аккаунт и настрой сбор

1. Открой `https://charmeeck.github.io/charmeeck-tears/admin.html`.
2. Войди с паролем `ADMIN_PASSWORD`.
3. Нажми «Подключить / переподключить DonationAlerts».
4. На странице DonationAlerts подтверди запрашиваемый доступ.
5. После возврата в панель укажи начальную сумму, цель и валюту.
6. Нажми «Сохранить суммы».

Для зачёта донаты должны приходить в выбранной валюте. Автоматической конвертации нет. Повторно полученные события с тем же ID не будут начислены дважды.

## 8. Добавь виджет в OBS

Создай источник «Браузер» и укажи:

`https://charmeeck.github.io/charmeeck-tears/widget/`

Размер: 1774 × 887. Не добавляй пароль, Client Secret или OAuth-токены в адрес OBS.

## Важно про безопасность и оплату

- OAuth Client Secret, access token, refresh token и ключ шифрования хранятся в секретах Cloudflare/зашифрованной базе, а не в публичном GitHub.
- Не используй один аккаунт/секреты DonationAlerts для передачи другим стримерам.
- В текущей схеме одна установка Worker и одна база рассчитаны на один аккаунт владельца. Для другого стримера нужна отдельная установка и отдельные секреты.
- Durable Object поддерживает постоянное WebSocket-подключение к DonationAlerts. Оно может расходовать лимиты и тарифицируемые ресурсы Cloudflare. Проверяй Usage/Billing; бесплатность не гарантируется.
- Реальное подключение не считается проверенным, пока владелец не завершит OAuth и не придёт тестовый донат.
