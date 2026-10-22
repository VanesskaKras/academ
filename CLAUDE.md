## Інтеграція з SW CRM

Замовлення можуть приходити не з UI, а з CRM через воркер (`worker/*`), за контрактом `docs/crm-integration.md`. Це зовнішній контракт: формат документа `orders/{id}` для CRM-замовлень (поля `tplText`, `comment`, `clientPlan`, `fileRef.url` по слотах), статуси `queued/running/done/error`, підколекція `costs`, і те, що воркер повертає у CRM — **не змінювати без оновлення контракту і погодження**. Файли `worker/*` та `docs/crm-integration.md` — спільна зона з CRM. Headless-режим має давати той самий `.docx`, що й кнопка в UI.
