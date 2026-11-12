# Tears Widget v70 — подключение нескольких стримеров

## Как устроено

Все стримеры используют один общий адрес панели и один Cloudflare Worker. Каждый стример отдельно авторизует СВОЙ аккаунт DonationAlerts и получает персональную ссылку OBS.

- Один OAuth-клиент DonationAlerts на владельца сервиса.
- Один Cloudflare Worker и одна D1 база на весь сервис.
- OAuth-токены хранятся зашифрованными в D1 и привязаны к конкретному DA user ID.
- Настройки суммы, цели и валюты хранятся отдельно для каждого аккаунта.
- Для каждого стримера создаётся отдельный Durable Object listener к его каналу DonationAlerts.
- История и защита от повторного начисления разделены по account_id.
- У каждого стримера отдельный ключ Browser Source. Виджет с этим ключом может читать только свой прогресс и события.

## Что потребуется владельцу сервиса один раз

1. GitHub Pages с репозиторием этого проекта.
2. Один аккаунт Cloudflare.
3. Один аккаунт DonationAlerts, в котором владелец создаст OAuth-приложение для сервиса.
4. Node.js LTS и Wrangler для публикации Worker.
5. D1 база `tears-donations`.

В Cloudflare Worker Secrets владелец задаёт:
- `DA_CLIENT_ID` — Client ID единого OAuth-приложения.
- `DA_CLIENT_SECRET` — Client Secret этого приложения.
- `APP_ENCRYPTION_KEY` — Base64 от 32 случайных байт.
- `INTERNAL_SECRET` — случайный hex-секрет для внутренних вызовов Durable Object.

OAuth Redirect URI для единого приложения:
`https://tears-donationalerts.charmwizard.workers.dev/oauth/callback`

Области доступа:
- `oauth-user-show`
- `oauth-donation-subscribe`

Эти реквизиты создаются только владельцем сервиса и не выдаются стримерам.

## Как подключается новый стример

1. Открывает общую страницу панели:
   `https://charmeeck.github.io/charmeeck-tears/admin.html`
2. Указывает стартовую сумму, цель и валюту.
3. Нажимает «Подключить DonationAlerts».
4. Входит в СВОЙ DonationAlerts и разрешает доступ приложению.
5. Возвращается в личную панель.
6. При необходимости меняет суммы и валюту.
7. Копирует личную ссылку OBS.
8. В OBS добавляет Browser Source и вставляет ссылку. Рекомендуемый размер — 1774 × 887.

Новому стримеру НЕ нужно создавать OAuth-приложение, Worker, базу данных или GitHub-репозиторий.

## Адреса

- Панель: `https://charmeeck.github.io/charmeeck-tears/admin.html`
- Виджет: `https://charmeeck.github.io/charmeeck-tears/widget/`
- Worker: `https://tears-donationalerts.charmwizard.workers.dev`

## Ограничения и безопасность

- Client Secret и OAuth-токены никогда не передаются в OBS.
- Владелец сервиса хранит ключи OAuth в Cloudflare Secrets.
- Access/Refresh Token каждого стримера хранятся зашифрованными в D1.
- Browser Source key — персональная секретная ссылка; не публикуй её.
- Донат в валюте, отличной от настроенной валюты сбора, не увеличивает прогресс. Автоконвертации нет.
- Каждому стримеру доступны только его собственная панель, настройки, донаты и канал событий.
- Одна установка обслуживает несколько аккаунтов; постоянное подключение Durable Object на каждого активного стримера расходует ресурсы Cloudflare. Следи за Usage/Billing.
