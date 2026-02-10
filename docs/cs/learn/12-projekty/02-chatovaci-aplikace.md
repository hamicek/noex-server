# Chatovací aplikace

Stavba multi-room chatovacího systému, kde se zprávy persistují ve Store, indikátory psaní a potvrzení přečtení proudí přes Rules a všichni účastníci vidí aktualizace v reálném čase přes push zprávy. Tento projekt kombinuje Store CRUD, reaktivní subscriptions, integraci rules, transakce a multi-client push.

## Co se naučíte

- Multi-bucket design: místnosti, zprávy a účastníci
- Reaktivní dotazy omezené na místnost (parametrizované subscriptions)
- Rules engine pro efemérní eventy (indikátory psaní, potvrzení přečtení)
- Multi-client push: jeden uživatel pošle zprávu, všichni účastníci místnosti ji vidí
- Transakce pro konzistentní aktualizace stavu (vytvoření místnosti + přidání prvního účastníka atomicky)
- Kombinace Store subscriptions (persistentní data) s Rules subscriptions (efemérní eventy)

## Přehled architektury

```text
┌────────────────────────────────────────────────────────────────────┐
│                       Chat Server                                   │
│                                                                     │
│  Store (persistentní)            Rules (efemérní)                  │
│  ┌────────────────────┐         ┌────────────────────────┐         │
│  │ rooms              │         │ Eventy:                │         │
│  │   name, createdAt  │         │   chat.typing          │         │
│  │                    │         │   chat.read            │         │
│  │ messages           │         │   chat.presence        │         │
│  │   roomId, sender,  │         │                        │         │
│  │   content, sentAt  │         │ Fakty:                 │         │
│  │                    │         │   user:<id>:status     │         │
│  │ participants       │         │   room:<id>:userCount  │         │
│  │   roomId, userId,  │         └────────────────────────┘         │
│  │   joinedAt         │                                            │
│  └────────────────────┘                                            │
│                                                                     │
│  Dotazy                          Subscriptions                     │
│  ┌────────────────────┐         ┌────────────────────────┐         │
│  │ room-messages(id)  │         │ Store: room-messages   │         │
│  │ room-list          │         │   → push při nové msg  │         │
│  │ message-count(id)  │         │                        │         │
│  │ room-participants  │         │ Rules: chat.*          │         │
│  └────────────────────┘         │   → push při psaní,   │         │
│                                 │     potvrzení přečtení │         │
│                                 └────────────────────────┘         │
│                                                                     │
│  Klienti                                                           │
│  ┌──────┐  ┌──────┐  ┌──────┐                                     │
│  │ Alice│  │ Bob  │  │ Carol│                                     │
│  │ send │  │ recv │  │ recv │                                     │
│  │ type │  │ push │  │ push │                                     │
│  └──────┘  └──────┘  └──────┘                                     │
└────────────────────────────────────────────────────────────────────┘
```

## Kompletní nastavení serveru

```typescript
import { Store } from '@hamicek/noex-store';
import { RuleEngine } from '@hamicek/noex-rules';
import { NoexServer } from '@hamicek/noex-server';

async function main() {
  const store = await Store.start({ name: 'chat' });
  const engine = await RuleEngine.start({ name: 'chat-rules' });

  // ── Buckety ─────────────────────────────────────────────────────

  await store.defineBucket('rooms', {
    key: 'id',
    schema: {
      id:        { type: 'string', generated: 'uuid' },
      name:      { type: 'string', required: true },
      createdAt: { type: 'number', required: true },
    },
  });

  await store.defineBucket('messages', {
    key: 'id',
    schema: {
      id:      { type: 'string', generated: 'uuid' },
      roomId:  { type: 'string', required: true },
      sender:  { type: 'string', required: true },
      content: { type: 'string', required: true },
      sentAt:  { type: 'number', required: true },
    },
  });

  await store.defineBucket('participants', {
    key: 'id',
    schema: {
      id:       { type: 'string', generated: 'uuid' },
      roomId:   { type: 'string', required: true },
      userId:   { type: 'string', required: true },
      joinedAt: { type: 'number', required: true },
    },
  });

  // ── Dotazy ─────────────────────────────────────────────────────

  store.defineQuery('room-messages', async (ctx, params: { roomId: string }) => {
    return ctx.bucket('messages').where({ roomId: params.roomId });
  });

  store.defineQuery('room-list', async (ctx) => {
    return ctx.bucket('rooms').all();
  });

  store.defineQuery('message-count', async (ctx, params: { roomId: string }) => {
    return ctx.bucket('messages').count({ roomId: params.roomId });
  });

  store.defineQuery('room-participants', async (ctx, params: { roomId: string }) => {
    return ctx.bucket('participants').where({ roomId: params.roomId });
  });

  // ── Server ──────────────────────────────────────────────────────

  const server = await NoexServer.start({
    port: 8080,
    store,
    rules: engine,
  });

  console.log(`Chat server naslouchá na ws://localhost:${server.port}`);
}

main();
```

## Interakce klientů: Multi-user chat flow

### Krok 1: Vytvoření místnosti s transakcí

Alice vytvoří místnost a připojí se do ní atomicky:

```jsonc
// Alice → Server
{ "id": 1, "type": "store.transaction", "operations": [
    { "op": "insert", "bucket": "rooms", "data": {
        "name": "General", "createdAt": 1706745600000
      }
    },
    { "op": "insert", "bucket": "participants", "data": {
        "roomId": "will-be-set-after", "userId": "alice", "joinedAt": 1706745600000
      }
    }
  ]
}

// Server → Alice
{ "id": 1, "type": "result", "data": { "results": [
    { "index": 0, "data": { "id": "room-1", "name": "General",
        "createdAt": 1706745600000, "_version": 1 } },
    { "index": 1, "data": { "id": "p-1", "roomId": "will-be-set-after",
        "userId": "alice", "joinedAt": 1706745600000, "_version": 1 } }
  ] }
}
```

> **Poznámka:** V reálné aplikaci byste nejprve vložili místnost pro získání jejího ID a poté vložili účastníka se správným `roomId`. Alternativně použijte UUID generované na klientovi jako ID místnosti.

Praktičtější přístup — nejprve vytvořit místnost, pak se připojit:

```jsonc
// Alice → Server (vytvoření místnosti)
{ "id": 1, "type": "store.insert", "bucket": "rooms", "data": {
    "name": "General", "createdAt": 1706745600000
  }
}

// Server → Alice
{ "id": 1, "type": "result", "data": { "id": "room-1", "name": "General",
    "createdAt": 1706745600000, "_version": 1 }
}

// Alice → Server (připojení do místnosti)
{ "id": 2, "type": "store.insert", "bucket": "participants", "data": {
    "roomId": "room-1", "userId": "alice", "joinedAt": 1706745600000
  }
}

// Server → Alice
{ "id": 2, "type": "result", "data": { "id": "p-1", "roomId": "room-1",
    "userId": "alice", "joinedAt": 1706745600000, "_version": 1 }
}
```

### Krok 2: Přihlášení k zprávám místnosti

Alice i Bob se přihlásí ke zprávám v místnosti „General":

```jsonc
// Alice → Server
{ "id": 3, "type": "store.subscribe", "query": "room-messages",
  "params": { "roomId": "room-1" } }

// Server → Alice (prázdná místnost, zatím žádné zprávy)
{ "id": 3, "type": "result", "data": { "subscriptionId": "sub-1", "data": [] } }
```

```jsonc
// Bob → Server
{ "id": 1, "type": "store.subscribe", "query": "room-messages",
  "params": { "roomId": "room-1" } }

// Server → Bob
{ "id": 1, "type": "result", "data": { "subscriptionId": "sub-2", "data": [] } }
```

### Krok 3: Přihlášení k indikátorům psaní (Rules)

Oba klienti se přihlásí k chat eventům pro místnost:

```jsonc
// Alice → Server
{ "id": 4, "type": "rules.subscribe", "pattern": "chat.*" }

// Server → Alice
{ "id": 4, "type": "result", "data": { "subscriptionId": "sub-3" } }
```

```jsonc
// Bob → Server
{ "id": 2, "type": "rules.subscribe", "pattern": "chat.*" }

// Server → Bob
{ "id": 2, "type": "result", "data": { "subscriptionId": "sub-4" } }
```

### Krok 4: Alice píše — indikátor psaní

Alice emituje typing event přes rules engine:

```jsonc
// Alice → Server
{ "id": 5, "type": "rules.emit", "topic": "chat.typing", "data": {
    "roomId": "room-1", "userId": "alice", "isTyping": true
  }
}

// Server → Alice (výsledek emitu)
{ "id": 5, "type": "result", "data": {
    "id": "evt-1", "topic": "chat.typing", "timestamp": 1706745610000,
    "data": { "roomId": "room-1", "userId": "alice", "isTyping": true }
  }
}
```

Alice i Bob obdrží typing event jako push:

```jsonc
// Server → Alice (push na rules subscription)
{ "type": "push", "channel": "event", "subscriptionId": "sub-3", "data": {
    "topic": "chat.typing",
    "event": {
      "id": "evt-1", "topic": "chat.typing", "timestamp": 1706745610000,
      "data": { "roomId": "room-1", "userId": "alice", "isTyping": true }
    }
  }
}

// Server → Bob (push na rules subscription)
{ "type": "push", "channel": "event", "subscriptionId": "sub-4", "data": {
    "topic": "chat.typing",
    "event": {
      "id": "evt-1", "topic": "chat.typing", "timestamp": 1706745610000,
      "data": { "roomId": "room-1", "userId": "alice", "isTyping": true }
    }
  }
}
```

### Krok 5: Alice pošle zprávu

```jsonc
// Alice → Server
{ "id": 6, "type": "store.insert", "bucket": "messages", "data": {
    "roomId": "room-1", "sender": "alice", "content": "Ahoj všichni!", "sentAt": 1706745615000
  }
}

// Server → Alice (výsledek insertu)
{ "id": 6, "type": "result", "data": {
    "id": "msg-1", "roomId": "room-1", "sender": "alice",
    "content": "Ahoj všichni!", "sentAt": 1706745615000, "_version": 1
  }
}
```

Po `store.settle()` oba odběratelé obdrží aktualizovaný seznam zpráv:

```jsonc
// Server → Alice (push na room-messages subscription)
{ "type": "push", "channel": "subscription", "subscriptionId": "sub-1", "data": [
    { "id": "msg-1", "roomId": "room-1", "sender": "alice",
      "content": "Ahoj všichni!", "sentAt": 1706745615000, "_version": 1 }
  ]
}

// Server → Bob (push na room-messages subscription)
{ "type": "push", "channel": "subscription", "subscriptionId": "sub-2", "data": [
    { "id": "msg-1", "roomId": "room-1", "sender": "alice",
      "content": "Ahoj všichni!", "sentAt": 1706745615000, "_version": 1 }
  ]
}
```

### Krok 6: Bob čte — potvrzení přečtení

Bob emituje potvrzení přečtení přes rules:

```jsonc
// Bob → Server
{ "id": 3, "type": "rules.emit", "topic": "chat.read", "data": {
    "roomId": "room-1", "userId": "bob", "lastReadMessageId": "msg-1"
  }
}

// Server → Bob
{ "id": 3, "type": "result", "data": {
    "id": "evt-2", "topic": "chat.read", "timestamp": 1706745620000,
    "data": { "roomId": "room-1", "userId": "bob", "lastReadMessageId": "msg-1" }
  }
}
```

Alice obdrží potvrzení přečtení:

```jsonc
// Server → Alice (push na rules subscription)
{ "type": "push", "channel": "event", "subscriptionId": "sub-3", "data": {
    "topic": "chat.read",
    "event": {
      "id": "evt-2", "topic": "chat.read", "timestamp": 1706745620000,
      "data": { "roomId": "room-1", "userId": "bob", "lastReadMessageId": "msg-1" }
    }
  }
}
```

### Krok 7: Sledování přítomnosti přes fakty

Použijte rules fakty pro sledování online/offline stavu:

```jsonc
// Alice → Server (nastavení online stavu)
{ "id": 7, "type": "rules.setFact", "key": "user:alice:status", "value": "online" }

// Server → Alice
{ "id": 7, "type": "result", "data": { "key": "user:alice:status", "value": "online" } }
```

Jakýkoli klient se může dotázat, kdo je online:

```jsonc
// Bob → Server
{ "id": 4, "type": "rules.queryFacts", "pattern": "user:*:status" }

// Server → Bob
{ "id": 4, "type": "result", "data": [
    { "key": "user:alice:status", "value": "online" }
  ]
}
```

## Podrobný rozbor

### Dva push kanály

Chat aplikace používá oba push kanály současně:

| Kanál | Zdroj | Použití | Tvar dat |
|-------|-------|---------|----------|
| `subscription` | Store dotazy | Seznamy zpráv, místností, účastníků | Kompletní výsledek dotazu (pole nebo skalár) |
| `event` | Rules engine | Indikátory psaní, potvrzení přečtení, přítomnost | `{ topic, event }` |

Store subscriptions doručují **kompletní aktuální stav** dotazu (celý seznam zpráv). Rules subscriptions doručují **individuální eventy** tak, jak nastanou (každý indikátor psaní samostatně). Tento rozdíl je zásadní:

- **Store push**: „Tady jsou všechny zprávy v místnosti právě teď" (nahrazuje předchozí stav)
- **Rules push**: „Alice právě začala psát" (přídavný event)

### Parametrizované dotazy

Dotaz `room-messages` přijímá parametr `roomId`. Každá subscription je nezávislá — přihlášení k `room-messages({ roomId: 'room-1' })` a `room-messages({ roomId: 'room-2' })` vytvoří dvě oddělené subscriptions s různými daty. Zpráva vložená do room-1 vyvolá push pouze pro subscription room-1.

### Proč Rules pro indikátory psaní?

Indikátory psaní jsou efemérní — nepotřebují se persistovat. Použití `rules.emit` broadcastuje event všem odběratelům bez zápisu do Store. Kdybyste ukládali stav psaní do bucketu, každý stisk klávesy by vyvolal zápis + přehodnocení dotazu + push, což je zbytečně nákladné.

Rules fakty (`user:alice:status`) jsou vhodné pro polo-persistentní stav jako přítomnost, protože se dají dotázat na vyžádání, ale nezaneřáďují Store.

### Vzory transakcí

Pro operace, které musí být konzistentní, použijte transakce:

```jsonc
// Smazání místnosti: odstranění všech zpráv, účastníků a samotné místnosti
{ "id": 10, "type": "store.transaction", "operations": [
    { "op": "where", "bucket": "messages", "filter": { "roomId": "room-1" } },
    { "op": "where", "bucket": "participants", "filter": { "roomId": "room-1" } },
    { "op": "delete", "bucket": "rooms", "key": "room-1" }
  ]
}
```

Operace `where` v rámci transakce čtou data a `delete` odstraní místnost — vše atomicky. Pro smazání zpráv a účastníků byste potřebovali individuální delete operace pro každý záznam (transakce nepodporují hromadné mazání).

## Cvičení

Rozšiřte chatovací systém o:

1. Subscription `message-count` per místnost — zobrazení „42 zpráv" v seznamu místností
2. Feature „nepřečtené počty" pomocí rules faktů: když Alice pošle zprávu, nastavte fakt `room:room-1:unread:bob`; když Bob čte, smažte fakt
3. Event `chat.presence` emitovaný při připojení nebo odpojení uživatele

<details>
<summary>Řešení</summary>

**Subscription počtu zpráv (již definovaný v nastavení serveru):**

```jsonc
// Bob → Server
{ "id": 5, "type": "store.subscribe", "query": "message-count",
  "params": { "roomId": "room-1" } }

// Server → Bob (počáteční počet)
{ "id": 5, "type": "result", "data": { "subscriptionId": "sub-5", "data": 3 } }

// Poté, co Alice pošle novou zprávu:
// Server → Bob (push s aktualizovaným počtem)
{ "type": "push", "channel": "subscription", "subscriptionId": "sub-5", "data": 4 }
```

**Nepřečtené počty s fakty:**

Když Alice pošle zprávu, nastaví také nepřečtené fakty pro ostatní účastníky:

```jsonc
// Alice → Server (označení nepřečteného pro Boba)
{ "id": 8, "type": "rules.setFact", "key": "room:room-1:unread:bob", "value": 1 }
```

Bob se dotáže na své nepřečtené místnosti:

```jsonc
// Bob → Server
{ "id": 6, "type": "rules.queryFacts", "pattern": "room:*:unread:bob" }

// Server → Bob
{ "id": 6, "type": "result", "data": [
    { "key": "room:room-1:unread:bob", "value": 1 }
  ]
}
```

Když Bob čte, vymaže nepřečtený fakt:

```jsonc
// Bob → Server
{ "id": 7, "type": "rules.deleteFact", "key": "room:room-1:unread:bob" }

// Server → Bob
{ "id": 7, "type": "result", "data": { "deleted": true } }
```

**Eventy přítomnosti:**

```jsonc
// Při připojení uživatele:
{ "id": 1, "type": "rules.emit", "topic": "chat.presence", "data": {
    "userId": "bob", "status": "online"
  }
}

// Při odpojení uživatele:
{ "id": 99, "type": "rules.emit", "topic": "chat.presence", "data": {
    "userId": "bob", "status": "offline"
  }
}
```

Všichni klienti přihlášení k `chat.*` obdrží push přítomnosti na kanálu `event`.

</details>

## Shrnutí

- **Dva push kanály**: Store subscriptions pro persistentní data (zprávy, místnosti), Rules subscriptions pro efemérní eventy (psaní, potvrzení přečtení)
- **Parametrizované dotazy**: `room-messages({ roomId })` omezuje každou subscription na jednu místnost
- **Rules pro efemérní data**: `rules.emit` broadcastuje bez zápisů do Store — ideální pro indikátory psaní
- **Rules fakty pro přítomnost**: `user:<id>:status` lze nastavit, dotázat a smazat bez bucketu
- **Transakce**: Atomické multi-operation aktualizace pro konzistentní vytváření a odstraňování místností
- **Multi-client push**: Mutace jakéhokoli klienta vyvolá push všem ostatním klientům s odpovídajícími subscriptions

---

Další: [E-commerce backend](./03-ecommerce-backend.md)
