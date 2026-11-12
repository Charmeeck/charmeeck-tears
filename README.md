# CharMeeck Tears

Анимированный OBS-донат-бар «Слёзы» v70 с общим многопользовательским подключением DonationAlerts.

## Страницы

- Главная: https://charmeeck.github.io/charmeeck-tears/
- Панель подключения: https://charmeeck.github.io/charmeeck-tears/admin.html
- Виджет для OBS: https://charmeeck.github.io/charmeeck-tears/widget/

## Для стримеров

Все стримеры используют общую панель. Каждый авторизует свой аккаунт DonationAlerts, задаёт собственные суммы и валюту, затем копирует персональную ссылку OBS. Создавать отдельный Worker, D1, GitHub или OAuth-приложение стримеру не нужно.

## Для владельца сервиса

Единый сервер расположен в Cloudflare Worker. Настройка, миграции, OAuth и безопасные секреты описаны в [INSTALL_CLOUDFLARE_RU.md](./INSTALL_CLOUDFLARE_RU.md).

Секреты единого OAuth-приложения задаются только через Cloudflare Worker Secrets. Токены стримеров зашифрованы в D1 и изолированы по аккаунтам.

## Важно

Реальное поступление донатов можно считать проверенным только после создания D1, настройки Worker Secrets, OAuth-приложения, подключения одного аккаунта и тестового доната.
