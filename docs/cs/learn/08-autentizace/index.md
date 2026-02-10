# Část 8: Autentizace

Zabezpečení serveru pomocí token-based autentizace, per-operation oprávnění a správy session.

## Kapitoly

### [8.1 Autentizace tokenem](./01-autentizace-tokenem.md)

Nastavení autentizace:
- `AuthConfig` s funkcí `validate`
- `auth.login` flow — token na session
- `required: true` — blokování neautentizovaných požadavků

### [8.2 Oprávnění](./02-opravneni.md)

Řízení toho, co může každý uživatel dělat:
- `PermissionConfig.check(session, operation, resource)`
- Vzory přístupu na základě rolí
- Error kód `FORBIDDEN` při zamítnutí

### [8.3 Životní cyklus session](./03-zivotni-cyklus-session.md)

Správa sessions v čase:
- `auth.whoami` — inspekce aktuální session
- `auth.logout` — ukončení session
- Expirace tokenu a re-autentizace

## Co se naučíte

Na konci této sekce budete schopni:
- Přidat token-based autentizaci na server
- Implementovat kontroly oprávnění na základě rolí
- Spravovat životní cyklus session včetně expirace a odhlášení

---

Začněte s: [Autentizace tokenem](./01-autentizace-tokenem.md)
