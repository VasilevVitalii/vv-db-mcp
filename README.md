# vv-db-mcp

MCP-сервер для работы с СУБД через единый набор инструментов поверх пакета
[`vv-db-connection`](https://github.com/VasilevVitalii/vv-db-connection).
Поддерживаемые СУБД: **MSSQL**, **PostgreSQL**, **Oracle**, **Firebird**.

Сервер не хранит учётные данные: подключения задаёт потребитель (конфиг MCP-клиента
или переменные окружения), пароли можно выносить в отдельный файл секретов.

## Установка и запуск

```bash
npm install -g vv-db-mcp
vv-db-mcp --config ./connections.json --secrets ./.secret
```

Если `--config` не задан, берётся `VV_DB_MCP_CONFIG`; нет ни того, ни другого — ошибка старта.
`--secrets` задаёт путь к файлу `key=value` (обязателен, только когда в конфиге есть
подстановки `${...}`); иначе берётся `VV_DB_MCP_SECRETS`. Уровень логирования —
`VV_DB_MCP_LOG_LEVEL` (`error|warn|info|debug`, по умолчанию `warn`).

## Конфигурация подключений

Файл конфига — JSON со списком `connections` (минимум одно) и необязательным блоком
`limits`. Пример — [`connections.example.json`](./connections.example.json).

### Общие поля подключения

| Поле          | Тип                                      | Обяз. | Описание |
|---------------|------------------------------------------|-------|----------|
| `name`        | string, `^[A-Za-z][A-Za-z0-9_-]{0,63}$`  | да    | Имя, по которому агент обращается к подключению. Уникально без учёта регистра. |
| `kind`        | `mssql` \| `pg` \| `ora` \| `fb`          | да    | Тип СУБД. |
| `description` | string                                   | нет   | Подсказка агенту; отдаётся в `list_connections`. |
| `limits`      | object                                   | нет   | Переопределение лимитов для этого подключения. |

Остальные поля — специфичны для `kind` и передаются в `new DbConnection(...)` как есть.

**`mssql`:** `server` (обяз.), `port` (1433), `database`, `auth`
(`{ "kind": "mssql", "user", "password" }` или `{ "kind": "ntlm", "domain", "user", "password" }`, обяз.),
`trustServerCertificate`, `encrypt`, `ca`, `connectTimeout`.

**`pg`:** `host` (обяз.), `port` (5432), `database` (обяз.), `user`, `password` (обяз.),
`ssl` (`true` или `{ "ca"?, "trustServerCertificate"? }`), `connectTimeout`.

**`ora`:** `host` (обяз.), `port` (1521), `service` (обяз.), `user`, `password` (обяз.),
`privilege`, `connectTimeout`, `queueTimeout`, `poolMin`, `poolMax`, `poolIncrement`.

**`fb`:** `host` (обяз.), `port` (3050), `database` (обяз.), `user`, `password` (обяз.),
`charset` (`UTF8`|`WIN1251`), `numericMode` (`lossy`|`safe`|`string`), `connectTimeout`.

### Лимиты

`timeoutMs` (60000), `maxTimeoutMs` (3600000), `maxRows` (1000), `maxRowsCap` (10000),
`maxCellChars` (65536), `maxBinaryBytes` (4096). Глобальный блок `limits`
переопределяется поэлементно блоком `limits` внутри подключения.

### Подстановка секретов

В любом строковом значении конфига (кроме `name` и `kind`) последовательность `${KEY}`
заменяется значением ключа `KEY` из файла секретов; `$${` даёт буквальное `${`.
Файл секретов — `key=value`, по одной паре на строку; строки с `#` — комментарии,
строки без `=` игнорируются, повторяющийся ключ — last-wins.

```json
{ "name": "dst", "kind": "pg", "host": "10.0.0.6", "database": "qort",
  "user": "writer", "password": "${DST_PASSWORD}" }
```

```text
# .secret
DST_PASSWORD=...
```

## Подключение к MCP-клиенту

Пример для MCP-клиента с stdio-транспортом:

```json
{
  "mcpServers": {
    "vv-db-mcp": {
      "command": "vv-db-mcp",
      "args": ["--config", "/path/to/connections.json", "--secrets", "/path/to/.secret"],
      "env": { "VV_DB_MCP_LOG_LEVEL": "warn" }
    }
  }
}
```

## Инструменты

| Инструмент | Описание |
|------------|----------|
| `list_connections` | Список подключений (имя, kind, заголовок, пользователь, описание). |
| `ping` | Проверка доступности подключения. |
| `version` | Версия СУБД подключения. |
| `execute_sql` | Выполнение SQL (SELECT/DML/DDL) с параметрами `:name`. |
| `execute_transaction` | Набор SQL-операторов в одной транзакции (commit/rollback). |
| `list_schemas` | Схемы базы. |
| `list_tables` / `list_views` | Таблицы / представления с необязательным фильтром по имени (материализованные — только PostgreSQL). |
| `describe_table` | Колонки, типы, ПК, комментарии. |
| `list_foreign_keys` | Внешние ключи. |
| `list_indexes` | Индексы (включая уникальные и составные). |
| `list_constraints` | Ограничения (PK/UNIQUE/CHECK). |
| `list_routines` | Процедуры и функции. |
| `list_triggers` | Триггеры. |
| `list_sequences` | Последовательности/генераторы. |
| `get_definition` | Текст определения объекта (view/function/procedure/trigger; DDL или body — зависит от СУБД). |
| `sample_rows` | Первые N строк таблицы или представления. |

Инструменты чтения помечены `readOnlyHint: true`; `execute_sql`/`execute_transaction` —
`destructiveHint: true`. Все инструменты принимают `connection` (имя подключения).
`timeoutMs` принимают `ping`, `version`, `execute_sql`, `execute_transaction` и
`sample_rows` (у метаданных-инструментов время ожидания берётся из лимита
подключения); `maxRows` — `execute_sql`/`execute_transaction`. `sample_rows.limit`
дополнительно капается `maxRowsCap` подключения (как и прочие листинги).

## Ошибки

Все ошибки возвращаются как `{ isError: true }` с текстом вида
`[kind] message`, где `kind` — тип (`connect`, `query`, `timeout`, `aborted`,
`invalid_argument`, `internal`, …). Для сбоя посередине набора операторов добавляются
`statementIndex` (0-based) и, при неопределённом исходе, `outcomeUnknown: true`.
Значения секретов из `password`-полей маскируются (`***`) во всех текстах ошибок;
значения короче 4 символов не маскируются (иначе текст обесценивается).

## Совместимость

- **PostgreSQL ≥ 11** — `list_routines` опирается на `pg_proc.prokind`.
- **Firebird ≥ 3** — `list_routines` опирается на `RDB$PACKAGE_NAME`.
- **Oracle ≥ 12c** — `all_users.oracle_maintained` (для исключения системных схем) появился в 12c.
- MSSQL — без дополнительных ограничений по версии.

### Примечания по окружению

- **Node 18**: поддерживается только как рантайм для уже собранного `dist/`; сборка и тесты требуют Node 20+ (dev-зависимости: `@types/node`, `typescript`, `vitest`).
- **`TZ=UTC`**: для корректной сериализации `timestamp without time zone`, `datetime` и Oracle `DATE` через `toISOString()` запускайте сервер с `TZ=UTC`; при других зонах наивные даты могут смещаться.

## Разработка

```bash
npm install
npm run build          # tsc
npm run test           # unit-тесты (vitest, без БД)
npm run test:integration  # интеграционные тесты (живые СУБД из .connect.json)
```

Интеграционные тесты читают локальный `.connect.json` (не публикуется) и пропускаются
для тех `kind`, для которых нет записи.

## Лицензия

MIT
