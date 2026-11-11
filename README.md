# CharMeeck Tears

Независимый проект анимированного OBS донат-бара «Слёзы».

## Страницы

- Главная: https://charmeeck.github.io/charmeeck-tears/
- Виджет для OBS: https://charmeeck.github.io/charmeeck-tears/widget/
- Панель владельца: https://charmeeck.github.io/charmeeck-tears/admin.html

## Как устроен проект

- GitHub Pages публикует статические страницы и файлы виджета.
- Cloudflare Worker выполняет безопасную OAuth-авторизацию DonationAlerts и принимает события донатов.
- Cloudflare D1 хранит настройки сбора, историю донатов и зашифрованные OAuth-токены.
- Durable Object поддерживает WebSocket-подключение к DonationAlerts и рассылает события открытым виджетам.

## Подключение

Подробная инструкция: [INSTALL_CLOUDFLARE_RU.md](./INSTALL_CLOUDFLARE_RU.md).

Серверная часть находится в папке `worker`. Перед запуском требуется настроить Cloudflare D1, секреты Worker и OAuth-приложение DonationAlerts.

## Важно

- В репозитории нет и не должно быть OAuth Client Secret, access/refresh tokens, пароля панели или ключей шифрования.
- Существующий виджет «Кровь» — отдельный проект и этим репозиторием не изменяется.
- Пока владелец не развернул Worker и не завершил OAuth, реальный приём донатов не активирован.
- Одна установка Worker рассчитана на один аккаунт владельца. Для другого стримера создаётся отдельная установка со своими секретами.

## Публикация GitHub Pages

Workflow: `.github/workflows/pages.yml`. Он публикует ветку `main` в GitHub Pages.
