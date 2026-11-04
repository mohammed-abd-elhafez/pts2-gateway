# تقرير الاختبارات: Tank Readings API

**التاريخ:** 2026-11-04 · **النتيجة:** 443 من 443 اختبار نجحوا · **الفشل:** 0 · **الملفات:** 32

الاختبارات بتشتغل على PostgreSQL حقيقي (مش mocks لقاعدة البيانات). رمز ✓ = نجح.

## الملخص

| الملف | الموضوع | عدد الاختبارات | النتيجة |
|---|---|---:|---|
| `api.test.ts` | الـ API كله من برّه | 49 | ✓ نجحوا |
| `app-role.test.ts` | حساب الـ database المحدود | 4 | ✓ نجحوا |
| `batches.test.ts` | بناء الدفعات | 18 | ✓ نجحوا |
| `caddyfile.test.ts` | إخفاء سر المحطة من اللوج | 9 | ✓ نجحوا |
| `config.test.ts` | إعدادات BATCH_MAX_ITEMS | 3 | ✓ نجحوا |
| `demo.test.ts` | بيانات التجربة | 6 | ✓ نجحوا |
| `findings.test.ts` | ملاحظات المراجعة النقدية | 27 | ✓ نجحوا |
| `import.tankmsr.test.ts` | استيراد ملف TANKMSR.CSV | 13 | ✓ نجحوا |
| `ingest.test.ts` | استقبال رفع الكنترولر | 17 | ✓ نجحوا |
| `ledger.property.test.ts` | اختبار خصائص عشوائي للـ ledger | 2 | ✓ نجحوا |
| `ledger.service.test.ts` | الـ ledger على database حقيقية | 30 | ✓ نجحوا |
| `ledger.test.ts` | منطق السلسلة (دالة step) | 13 | ✓ نجحوا |
| `lookup.test.ts` | البحث عن المحطة بالكود | 7 | ✓ نجحوا |
| `migrate.test.ts` | تحديث هيكل الـ database | 3 | ✓ نجحوا |
| `migration003.test.ts` | migration رقم 003 على بيانات موجودة | 2 | ✓ نجحوا |
| `model.test.ts` | محاكاة عشوائية مع MoEnergy وهمي | 1 | ✓ نجحوا |
| `ops-lib.test.ts` | سكريبتات التشغيل والتنبيهات | 12 | ✓ نجحوا |
| `pool.test.ts` | اتصال الـ database والإعدادات | 11 | ✓ نجحوا |
| `prune.test.ts` | حذف الرفع الخام القديم | 4 | ✓ نجحوا |
| `quantity.test.ts` | قراءة الأرقام بدقة | 35 | ✓ نجحوا |
| `result.test.ts` | معالجة رد MoEnergy | 41 | ✓ نجحوا |
| `rules.test.ts` | قواعد التحقق من القراءة | 14 | ✓ نجحوا |
| `schema.test.ts` | قيود الـ database | 27 | ✓ نجحوا |
| `send-from.test.ts` | وقت بدء الإرسال (send_from) | 6 | ✓ نجحوا |
| `serialize.test.ts` | شكل الـ JSON الخارج | 9 | ✓ نجحوا |
| `sim.charts.test.ts` | جداول معايرة المحاكاة | 8 | ✓ نجحوا |
| `sim.csv.test.ts` | كتابة ملف CSV المحاكي | 3 | ✓ نجحوا |
| `sim.fake.test.ts` | MoEnergy الوهمي | 18 | ✓ نجحوا |
| `sim.model.test.ts` | مولّد المحطات | 15 | ✓ نجحوا |
| `sim.run.test.ts` | تشغيل السيناريو الكامل | 8 | ✓ نجحوا |
| `stations.load.test.ts` | تحميل المحطات من CSV | 22 | ✓ نجحوا |
| `status.test.ts` | حالة المحطة (status) | 6 | ✓ نجحوا |

## الاختبارات الأكبر من الوحدات

- **المحاكاة الكاملة:** 38 محطة × 30 يوم = 143,048 سجل مع أعطال متعمدة. اتقبل 141,003 في 59 دفعة، وكل الفحوصات النهائية نجحت (24 ثانية).
- **اختبار الحمل:** 273,600 قراءة اتصرّفت في حوالي 18 ثانية (حوالي 15 ألف/ثانية).
- **اختبار حي على السيرفر:** `/status` بدون مفتاح = 401، بمفتاح صحيح = رد سليم، بعد الإلغاء المفتاح مرفوض.
- **Mutation check** (`scripts/mutation-check.py`): بيكسر حارس واحد كل مرة ويتأكد إن الاختبارات تلاحظ. **ما اتشغلش في هذا التقرير.**

## اللي الاختبارات ما بتثبتوش

- سلوك MoEnergy الحقيقي: المحاكي مكتوب مننا من الـ guide (يحتاج مفتاح Preproduction).
- الـ parser وصيغة jsonPTS: لسه ما شفناهاش.
- TLS من كنترولر حقيقي، والأداء تحت الحمل على السيرفر الفعلي.

---

## تفصيل كل ملف

### `api.test.ts`: الـ API كله من برّه

- **إيه ده:** بيجرب كل رابط في الـ API: المفتاح (ناقص أو غلط أو ملغي)، الأخطاء 404/409/422/503، وإن كل محطة تشوف بياناتها بس.
- **ليه مهم:** لو فيه ثغرة هنا يبقى حد يشوف بيانات محطة مش بتاعته أو الدفعة تتعلق.
- **النتيجة:** 49 من 49 نجحوا

<details><summary>الاختبارات واحد واحد</summary>

- ✓ authentication › GET /v1/stations/OP-1/readings/batches/next refuses a missing key
- ✓ authentication › POST /v1/stations/OP-1/readings/batches/1/result refuses a missing key
- ✓ authentication › POST /v1/stations/OP-1/tanks/ST-000001-1/anchor refuses a missing key
- ✓ authentication › GET /v1/stations/OP-1/readings/batches/next refuses a wrong key, a revoked key and another scheme
- ✓ authentication › POST /v1/stations/OP-1/readings/batches/1/result refuses a wrong key, a revoked key and another scheme
- ✓ authentication › POST /v1/stations/OP-1/tanks/ST-000001-1/anchor refuses a wrong key, a revoked key and another scheme
- ✓ authentication › refuses before reading the body: broken JSON without a key is 401, not 422
- ✓ authentication › stores only a hash of the key
- ✓ GET /v1/readings/batches/next › answers 204 with no body when nothing is ready
- ✓ GET /v1/readings/batches/next › runs the ledger first, so stored readings appear without any other step
- ✓ GET /v1/readings/batches/next › returns the same batch, id and body until its result is posted
- ✓ POST /v1/readings/batches/:id/result › closes the batch on a 200 answer, replays an identical repeat, and refuses a different one
- ✓ POST /v1/readings/batches/:id/result › tells the client to resend on a retryable answer and keeps the same batch
- ✓ POST /v1/readings/batches/:id/result › answers 404 for a batch that does not exist or an id that is not a number
- ✓ POST /v1/readings/batches/:id/result › answers 422 naming the field for a missing status_code
- ✓ POST /v1/readings/batches/:id/result › answers 422 naming the field for an extra property
- ✓ POST /v1/readings/batches/:id/result › answers 422 naming the field for a status_code that is not an integer
- ✓ POST /v1/readings/batches/:id/result › answers 422 naming the field for a status_code below 100
- ✓ POST /v1/readings/batches/:id/result › answers 422 naming the field for a status_code above 599
- ✓ POST /v1/readings/batches/:id/result › answers 422 for a body that is not JSON or not an object, and 415 for an unsupported content type
- ✓ POST /v1/readings/batches/:id/result › carries a chain break through to a held tank, a rebuilt batch, an anchor and a resumed chain
- ✓ POST /v1/tanks/:tank_code/anchor › answers 404 for an unknown tank code
- ✓ POST /v1/tanks/:tank_code/anchor › answers 422 for a text that is not a number
- ✓ POST /v1/tanks/:tank_code/anchor › answers 422 for a negative quantity
- ✓ POST /v1/tanks/:tank_code/anchor › answers 422 for an exponent form
- ✓ POST /v1/tanks/:tank_code/anchor › answers 422 for a missing reason
- ✓ POST /v1/tanks/:tank_code/anchor › answers 422 for an empty reason
- ✓ POST /v1/tanks/:tank_code/anchor › answers 422 for an unknown property
- ✓ POST /v1/tanks/:tank_code/anchor › uses the configured number of decimals for the value it keeps (two by default)
- ✓ POST /v1/tanks/:tank_code/anchor › answers 409 while the tank still has readings MoEnergy has not accepted
- ✓ POST /v1/tanks/:tank_code/anchor › starts a tank that already reports to MoEnergy from the given quantity and records who set it
- ✓ one link per station › gives every station its own batch, carrying only that station's tanks
- ✓ one link per station › keeps one station's unreported batch from holding up another
- ✓ one link per station › only runs the ledger for the station that asked
- ✓ one link per station › answers 404 when a batch id from another station is used
- ✓ one link per station › answers 404 when an anchor names a tank of another station
- ✓ one link per station › finds the station by its code whatever the case, and answers 404 for an unknown one
- ✓ one link per station › checks the key before the station, so an unknown station is not revealed without one
- ✓ one link per station › answers 404 for an unknown station before reading the body
- ✓ one link per station › a key bound to one station › opens that station and no other, on every route, and hides the other as not found
- ✓ one link per station › a key bound to one station › answers a foreign station exactly as it answers a station that does not exist
- ✓ requests that do not match a route or a station › answers a plain 404 that never echoes the path
- ✓ requests that do not match a route or a station › refuses a body over 1 MB on any route that is not ingest
- ✓ requests that do not match a route or a station › answers the same 404 for a station code with a NUL byte
- ✓ requests that do not match a route or a station › answers the same 404 for a station code with a control character
- ✓ requests that do not match a route or a station › answers the same 404 for a station code with 65 characters
- ✓ result correlation id › refuses a result that names another send with 409, and accepts the right one
- ✓ when the database is slow or busy › answers 503 busy instead of hanging when a station lock cannot be taken in time
- ✓ one tank that cannot be processed › does not stop the station's other tanks or its open batch

</details>

### `app-role.test.ts`: حساب الـ database المحدود

- **إيه ده:** بيتأكد إن التطبيق بيشتغل بحساب `pts2_app` اللي مالوش صلاحية يغيّر هيكل الجداول، ومع كده كل رحلة البيانات شغالة بيه.
- **ليه مهم:** لو التطبيق اتخترق، الضرر محدود.
- **النتيجة:** 4 من 4 نجحوا

<details><summary>الاختبارات واحد واحد</summary>

- ✓ the restricted application role › is not a superuser and cannot change the schema
- ✓ the restricted application role › can be set up twice, and a second call changes the password
- ✓ the restricted application role › runs the whole path: an upload, a batch built by the ledger, and its result
- ✓ the restricted application role › reaches tables made by a migration that ran after the role was set up

</details>

### `batches.test.ts`: بناء الدفعات

- **إيه ده:** بيبني الدفعة اللي هتتبعت للعميل: ترتيب بالزمن، أسماء الحقول زي الـ guide، تحويل الارتفاع لمتر، حد الحجم 1 MB، ودفعة واحدة مفتوحة بس.
- **ليه مهم:** لو الدفعة غلط، MoEnergy بترفضها كلها.
- **النتيجة:** 18 من 18 نجحوا

<details><summary>الاختبارات واحد واحد</summary>

- ✓ getOrCreateNextBatch › returns null when nothing is ready
- ✓ getOrCreateNextBatch › builds one batch in time order across tanks, with exact positions and size
- ✓ getOrCreateNextBatch › uses the guide field names and converts heights from millimetres to metres
- ✓ getOrCreateNextBatch › returns the same open batch again, even after more readings were emitted
- ✓ getOrCreateNextBatch › builds the next batch only after the open one is closed, continuing where it stopped
- ✓ getOrCreateNextBatch › skips tanks and stations that do not have MoEnergy codes yet
- ✓ getOrCreateNextBatch › holds back a reading inside the settle window and everything after it on that tank only
- ✓ getOrCreateNextBatch › respects the size cap and keeps each tank in time order across batches
- ✓ getOrCreateNextBatch › stops at maxItems and carries the rest into the next batch, in order
- ✓ getOrCreateNextBatch › still sends a single reading that alone exceeds the cap, so the queue never stalls
- ✓ getOrCreateNextBatch › builds exactly one batch when many callers ask at once
- ✓ getOrCreateNextBatch › stations are independent › gives each station its own batch with only its own tanks, open at the same time
- ✓ getOrCreateNextBatch › stations are independent › does not let one station's open batch hold up another
- ✓ getOrCreateNextBatch › stations are independent › builds one batch per station when many callers ask for both at once
- ✓ getOrCreateNextBatch › stations are independent › returns null for a station that does not exist
- ✓ getOrCreateNextBatch › refuses to serve an open batch whose underlying rows changed since it was built, even by one character
- ✓ getOrCreateNextBatch › reads a tank as a prefix when it has more unsent readings than one build looks at, skipping none
- ✓ inactive tanks › are not put into a batch

</details>

### `caddyfile.test.ts`: إخفاء سر المحطة من اللوج

- **إيه ده:** بيجرب أشكال الرابط (سلاش مزدوج، حروف كبيرة، query) ويتأكد إن السر بيتبدل بـ `***` في لوج Caddy.
- **ليه مهم:** ده خطأ حصل فعلاً على السيرفر واتصلح.
- **النتيجة:** 9 من 9 نجحوا

<details><summary>الاختبارات واحد واحد</summary>

- ✓ the access log hides a station secret in the path › the normal address
- ✓ the access log hides a station secret in the path › no further path
- ✓ the access log hides a station secret in the path › a doubled slash before
- ✓ the access log hides a station secret in the path › a doubled slash after
- ✓ the access log hides a station secret in the path › another case
- ✓ the access log hides a station secret in the path › a prefix
- ✓ the access log hides a station secret in the path › a query string
- ✓ the access log hides a station secret in the path › leaves the client API paths alone
- ✓ the access log hides a station secret in the path › still drops the credential headers

</details>

### `config.test.ts`: إعدادات BATCH_MAX_ITEMS

- **إيه ده:** بيتأكد إن الحد الأقصى لعدد القراءات في الدفعة بيتقرا صح ويرفض الصفر والنص.
- **ليه مهم:** إعداد غلط ممكن يوقف الإرسال.
- **النتيجة:** 3 من 3 نجحوا

<details><summary>الاختبارات واحد واحد</summary>

- ✓ BATCH_MAX_ITEMS › is unset by default
- ✓ BATCH_MAX_ITEMS › is read as a positive integer
- ✓ BATCH_MAX_ITEMS › refuses zero and text

</details>

### `demo.test.ts`: بيانات التجربة

- **إيه ده:** بيتأكد إن بيانات الـ demo بتتعمل مرة واحدة، وإن مفتاح قصير مرفوض.
- **ليه مهم:** اتجرب على Render أول مرة.
- **النتيجة:** 6 من 6 نجحوا

<details><summary>الاختبارات واحد واحد</summary>

- ✓ a client key chosen by the operator › can be given instead of generated, and then opens the API
- ✓ a client key chosen by the operator › is refused when it is too short to be a secret
- ✓ seedDemo › creates stations with five tanks, their readings, and a client key
- ✓ seedDemo › does nothing the second time, so a restart of the service does not pile up data
- ✓ seedDemo › has its readings ready at once: a person trying the API right after the deploy gets a batch, not a 204
- ✓ seedDemo › refuses to seed without a key long enough to be a secret

</details>

### `findings.test.ts`: ملاحظات المراجعة النقدية

- **إيه ده:** كل اختبار هنا بيغطي مشكلة اتلقت في المراجعة (F1…F20 وH1,H2): تانك قراءته 0 لتر، المرساة (anchor)، سباقات المزامنة، تسريب السر، NUL byte…
- **ليه مهم:** دي المشاكل اللي اتلقت واتصلحت، وبتفضل محمية.
- **النتيجة:** 27 من 27 نجحوا

<details><summary>الاختبارات واحد واحد</summary>

- ✓ chain: a low reading must not kill the tank › F1a: a tank that read 0 L goes on after a refill
- ✓ chain: a low reading must not kill the tank › F1b: a reading below the water level does not make every later reading unsendable
- ✓ chain: a low reading must not kill the tank › F2: a corrupt volume the column accepts is set aside, not a tank that fails forever
- ✓ chain: a low reading must not kill the tank › F3: a second late reading is re-chained when everything after it is unsent, even if the first late one could not be
- ✓ item 3 and anchors: readings MoEnergy already holds › F4: first start of an existing tank with an overlapping backlog loses nothing
- ✓ item 3 and anchors: readings MoEnergy already holds › F5: a tank whose backlog holds a stored reading in the middle has a way out
- ✓ item 3 and anchors: readings MoEnergy already holds › F6: a batch that came back with a short count can still be closed
- ✓ anchor semantics › F7: under the hold policy a refill can be passed by anchoring what MoEnergy really holds
- ✓ anchor semantics › F8: when MoEnergy refuses negative consumed, a true anchor does not set aside one good reading per round
- ✓ anchor semantics › F9: an anchor above the tank capacity is refused
- ✓ anchor semantics › F10: an anchor with more than 3 decimals is refused, as the guide says
- ✓ concurrency › F11: a re-chain landing inside a batch build cannot produce a batch that differs from its rows
- ✓ concurrency › F12: one station waiting on its lock does not stop another station uploading
- ✓ security › F13: a mistyped upload URL (//pts/%s) keeps the secret out of the log
- ✓ security › F13: a mistyped upload URL (/PTS/%s) keeps the secret out of the log
- ✓ security › F13: a mistyped upload URL (/api/pts/%s) keeps the secret out of the log
- ✓ security › F14: the secret repeated later in the path is not stored
- ✓ security › F15: a malformed percent escape does not echo the secret or answer outside the error contract
- ✓ security › F16: a NUL byte in the anchor reason answers 422, not 500
- ✓ security › F17: a NUL byte in the tank code answers 404, not 500
- ✓ security › H1: a station-bound key cannot tell a foreign station from a missing one, or touch its batch or tank
- ✓ numbers › H2: values at the third decimal round half away from zero and stay plain JSON numbers
- ✓ result replay › F18: the same answer with its keys in another order is a replay, not a different answer
- ✓ schema › F19: migration 004 runs on a database that has a held tank
- ✓ third review › F20: GET next for one station waiting on a tank lock does not stop another station uploading
- ✓ third review › batch_results keeps a bounded number of repeat attempts and no oversized body
- ✓ third review › a tank cannot hold more than 10 million litres

</details>

### `import.tankmsr.test.ts`: استيراد ملف TANKMSR.CSV

- **إيه ده:** بيقرا ملف الكنترولر الحقيقي: يحوّل الوقت المحلي لـ UTC، يعزل صفوف 00:00:00، ويتخطى اللي من غير لترات.
- **ليه مهم:** أول محطة حقيقية جات بالشكل ده.
- **النتيجة:** 13 من 13 نجحوا

<details><summary>الاختبارات واحد واحد</summary>

- ✓ parseTankMsr › reads a real row: local time to UTC, millimetres, litres
- ✓ parseTankMsr › reads the zone from the argument
- ✓ parseTankMsr › gives no volume when the controller has no chart for the row
- ✓ parseTankMsr › marks a row stamped 00:00:00 as clock_invalid
- ✓ parseTankMsr › refuses a file whose header is not a TANKMSR.CSV header
- ✓ parseTankMsr › reports bad lines with their line number and keeps the good ones
- ✓ importTankMsr › stores what MoEnergy can use, sets the 00:00:00 rows aside, and skips rows without litres
- ✓ importTankMsr › stores the golden row with every value and the UTC time
- ✓ importTankMsr › is safe to run twice on the same file
- ✓ importTankMsr › leaves out rows before the start date
- ✓ importTankMsr › reports a probe the station has no tank for, and imports the rest
- ✓ importTankMsr › uses the zone of the station unless told otherwise
- ✓ importTankMsr › feeds the ledger: the refill becomes one negative consumed, nothing else is held back

</details>

### `ingest.test.ts`: استقبال رفع الكنترولر

- **إيه ده:** بيجرب رابط الرفع `/pts/<سر>`: يرفض السر الغلط، يخزن الـ bytes الحقيقية قبل الرد، ويتحمل 100 ألف سجل وJSON مكسور.
- **ليه مهم:** أي رفع بيضيع هنا بيضيع للأبد.
- **النتيجة:** 17 من 17 نجحوا

<details><summary>الاختبارات واحد واحد</summary>

- ✓ capture endpoint › refuses an unknown secret and stores nothing
- ✓ capture endpoint › refuses a request that carries no secret at all
- ✓ capture endpoint › accepts the secret in the path, stores exact bytes and answers with the configured reply
- ✓ capture endpoint › accepts the secret as the Basic password
- ✓ capture endpoint › keeps a body that is not JSON, and an empty body
- ✓ capture endpoint › keeps a 100,000-record backlog intact
- ✓ capture endpoint › answers 413 above the body limit and stores nothing
- ✓ capture endpoint › never writes the secret or credentials to storage or logs
- ✓ before the body is read › answers 401 for an unknown secret without reading a body far over the limit
- ✓ before the body is read › does not take a secret from a path with an empty segment
- ✓ the secret never lands anywhere › is removed from header values and the query string before storing, and kept out of the logs
- ✓ the secret never lands anywhere › is not echoed or logged when a method nobody handles is used
- ✓ JSON that PostgreSQL refuses › keeps the raw bytes of a lone surrogate escape and answers 200, so the controller does not resend forever
- ✓ JSON that PostgreSQL refuses › keeps the raw bytes of a lone low surrogate inside an object and answers 200, so the controller does not resend forever
- ✓ JSON that PostgreSQL refuses › keeps the raw bytes of an array nested 20,000 deep and answers 200, so the controller does not resend forever
- ✓ health › reports liveness without touching the database
- ✓ health › reports ready while the database answers and 503 when it does not

</details>

### `ledger.property.test.ts`: اختبار خصائص عشوائي للـ ledger

- **إيه ده:** بيولّد بيانات عشوائية كتير ويتأكد إن قاعدتي السلسلة بيتحققوا دايماً.
- **ليه مهم:** بيلقط حالات ما فكرناش فيها.
- **النتيجة:** 2 من 2 نجحوا

<details><summary>الاختبارات واحد واحد</summary>

- ✓ ledger properties › every emitted reading satisfies both MoEnergy chain rules, whatever else is dropped or held
- ✓ ledger properties › dropping any readings from a valid run leaves a valid chain

</details>

### `ledger.service.test.ts`: الـ ledger على database حقيقية

- **إيه ده:** بيتأكد إن القراءات بتتسلسل صح، بتتحمل التكرار والتوازي، والعزل، والتعبئة، والمرساة، والرول-باك لو فشلت نص الكتابة.
- **ليه مهم:** قلب المشروع: السلسلة اللي MoEnergy بتفحصها.
- **النتيجة:** 30 من 30 نجحوا

<details><summary>الاختبارات واحد واحد</summary>

- ✓ processTank › emits pending readings in time order with a gapless sequence and an exact chain
- ✓ processTank › is idempotent: a second run finds nothing to do
- ✓ processTank › continues the chain across separate runs
- ✓ processTank › quarantines with the rule code and leaves the chain untouched
- ✓ processTank › puts an older reading back in order when everything after it is still unsent
- ✓ processTank › sets an older reading aside as late_arrival once later readings may already be at MoEnergy
- ✓ processTank › leaves unsent readings untouched when the late reading cannot be placed anyway
- ✓ processTank › does not chain a reading until it has settled, and lets it hold back the ones after it
- ✓ processTank › lets a replayed older reading take its place when it arrives inside the window
- ✓ processTank › quarantines a reading with no litre volume
- ✓ processTank › converts heights from millimetres to metres before comparing with the tank height
- ✓ processTank › marks refills when policy is allow
- ✓ processTank › honours the limit and carries on in the next call
- ✓ processTank › works in whole seconds: two readings in one second are not both sent
- ✓ processTank › fails clearly for an unknown tank
- ✓ hold policy and anchors › holds the tank at a refill, keeps later readings pending, and resumes from the anchor
- ✓ hold policy and anchors › holds again if the anchor still leaves the next reading below the measurement
- ✓ hold policy and anchors › lets the reading that stopped the tank pass once a person has anchored it (F7)
- ✓ hold policy and anchors › sets aside readings at or before the anchor time as already at MoEnergy (F4)
- ✓ hold policy and anchors › records why and since when a tank is held, and clears both on an anchor
- ✓ hold policy and anchors › releases a hold made by the hold policy when the deployment now allows negative consumed
- ✓ hold policy and anchors › does not release any other kind of hold when the policy changes
- ✓ hold policy and anchors › applies an anchor to a tank with no readings yet, then ignores it once the chain has moved on
- ✓ hold policy and anchors › keeps every anchor and records who set it and when it applies
- ✓ concurrency › never forks a chain when several runs process one tank at once
- ✓ concurrency › lets different tanks run in parallel without touching each other
- ✓ concurrency › rolls back entirely when a write fails midway
- ✓ emission window › emits at most the window ahead of what has been sent and leaves the rest pending
- ✓ decimals › rounds the measurement once, so the next fuel_quantity equals the previous remaining exactly
- ✓ decimals › keeps three decimals when asked to

</details>

### `ledger.test.ts`: منطق السلسلة (دالة step)

- **إيه ده:** بيجرب الحساب نفسه: كل قراءة تبدأ من `remaining` اللي قبلها، والعزل، والتعبئة (consumed سالب).
- **ليه مهم:** لو الحساب غلط الدفعة كلها تترفض.
- **النتيجة:** 13 من 13 نجحوا

<details><summary>الاختبارات واحد واحد</summary>

- ✓ step › starts a chain from the first measurement with nothing consumed
- ✓ step › chains each reading from the previous remaining
- ✓ step › skips a measurement at or below the water volume and chains the next one from the last real value (F1)
- ✓ step › keeps the chain intact across a quarantined reading
- ✓ step › quarantines a reading without a litre volume
- ✓ step › quarantines a reading at or before the last emitted time as late_arrival
- ✓ step › under allow, emits a refill with negative consumed and marks it
- ✓ step › under allow, a small negative value without a delivery flag is noise but still emitted
- ✓ step › under hold, stops at negative consumed and keeps the chain where it was
- ✓ step › resumes from the anchor after a hold
- ✓ step › rejects an anchor above capacity through the next reading
- ✓ step › first reading of an empty tank is quarantined (water must stay below fuel)
- ✓ step › carries a dropped temperature flag onto the emitted reading

</details>

### `lookup.test.ts`: البحث عن المحطة بالكود

- **إيه ده:** بيتأكد إن الأكواد الغريبة (فاضي، NUL، سطر جديد) ما توصلش للـ database أصلاً.
- **ليه مهم:** حماية من أخطاء 500 وتسريب.
- **النتيجة:** 7 من 7 نجحوا

<details><summary>الاختبارات واحد واحد</summary>

- ✓ findStationByOperatorCode › never asks the database about a code that is empty
- ✓ findStationByOperatorCode › never asks the database about a code that is a NUL byte
- ✓ findStationByOperatorCode › never asks the database about a code that is a newline
- ✓ findStationByOperatorCode › never asks the database about a code that is a DEL character
- ✓ findStationByOperatorCode › never asks the database about a code that is 65 characters
- ✓ findStationByOperatorCode › finds a station by its code whatever the case, up to 64 characters
- ✓ storeUpload › removes the secret from the query and from header values by itself, not only because the route did

</details>

### `migrate.test.ts`: تحديث هيكل الـ database

- **إيه ده:** بيتأكد إن كل migration بتتطبق مرة واحدة، وبتتلغي بالكامل لو فشلت.
- **ليه مهم:** أي تحديث للسيرفر بيعدي من هنا.
- **النتيجة:** 3 من 3 نجحوا

<details><summary>الاختبارات واحد واحد</summary>

- ✓ migrate › applies each file once and is idempotent
- ✓ migrate › rolls a failing file back completely and reports its name
- ✓ migrate › rejects an unsafe table name

</details>

### `migration003.test.ts`: migration رقم 003 على بيانات موجودة

- **إيه ده:** بيجرب الترقية على database فيها بيانات فعلاً.
- **ليه مهم:** الترقية بدون خسارة بيانات.
- **النتيجة:** 2 من 2 نجحوا

<details><summary>الاختبارات واحد واحد</summary>

- ✓ migration 003 on a database that has data › refuses to run while one open batch holds readings of several stations
- ✓ migration 003 on a database that has data › gives an open batch and an accepted batch their station, leaves history it cannot place empty, and then guards new rows

</details>

### `model.test.ts`: محاكاة عشوائية مع MoEnergy وهمي

- **إيه ده:** بيشغل تدفقات عشوائية ويتأكد إن القواعد الأساسية (invariants) ما بتتكسرش.
- **ليه مهم:** بيلقط تفاعلات معقدة.
- **النتيجة:** 1 من 1 نجحوا

<details><summary>الاختبارات واحد واحد</summary>

- ✓ random flows against a fake MoEnergy › holds the invariants

</details>

### `ops-lib.test.ts`: سكريبتات التشغيل والتنبيهات

- **إيه ده:** بيجرب `alert()` (Telegram وwebhook)، اختيار ملفات compose، وتحذيرات النسخ الخارجي والتنبيهات.
- **ليه مهم:** التنبيهات هي اللي هتنبهنا لو حاجة وقعت.
- **النتيجة:** 12 من 12 نجحوا

<details><summary>الاختبارات واحد واحد</summary>

- ✓ alert() › sends to Telegram, with the token kept off the command line
- ✓ alert() › sends to the webhook as before
- ✓ alert() › does nothing outside the log when no channel is configured
- ✓ alert() › sends to both channels when both are configured
- ✓ compose() › uses the files named by COMPOSE_FILE in .env, in order
- ✓ compose() › defaults to the production pair
- ✓ offsite_check() › warns when backups are only on this server
- ✓ offsite_check() › is silent when the last copy off the server is recent
- ✓ offsite_check() › is critical when the copy off the server is stale or has never happened
- ✓ alerts_check() › warns when alerts have nowhere to go
- ✓ alerts_check() › is silent with Telegram or a webhook configured
- ✓ alerts_check() › warns about a Telegram token without a chat id

</details>

### `pool.test.ts`: اتصال الـ database والإعدادات

- **إيه ده:** بيتأكد إن كل انتظار له مهلة، وإن الاتصال بيتعافى لو الـ database قطعته، وإن كلمة السر الافتراضية مرفوضة.
- **ليه مهم:** سيرفر بدون تعليق.
- **النتيجة:** 11 من 11 نجحوا

<details><summary>الاختبارات واحد واحد</summary>

- ✓ createPool › bounds every wait
- ✓ createPool › survives the database dropping an idle connection, and reports it
- ✓ createPool › gives up waiting for a free connection instead of queueing forever
- ✓ loadConfig › refuses the example database password
- ✓ loadConfig › reads the database timeouts and validates them
- ✓ QUANTITY_DECIMALS › is 2 by default, accepts 3, refuses anything else
- ✓ sslFromEnv (for a database reached over the internet, such as a managed one) › leaves SSL to the connection string when PGSSL is not set
- ✓ sslFromEnv (for a database reached over the internet, such as a managed one) › "require" encrypts and checks the server certificate
- ✓ sslFromEnv (for a database reached over the internet, such as a managed one) › "no-verify" encrypts without checking the certificate
- ✓ sslFromEnv (for a database reached over the internet, such as a managed one) › refuses any other value rather than guessing
- ✓ sslFromEnv (for a database reached over the internet, such as a managed one) › is passed on to the connection

</details>

### `prune.test.ts`: حذف الرفع الخام القديم

- **إيه ده:** بيتأكد إن بعد 90 يوم بيتحذف الخام بس، والقراءات بتفضل، وبياخد دفعات صغيرة.
- **ليه مهم:** منع امتلاء القرص.
- **النتيجة:** 4 من 4 نجحوا

<details><summary>الاختبارات واحد واحد</summary>

- ✓ pruneRawUploads › removes uploads older than the retention and keeps newer ones
- ✓ pruneRawUploads › works through a large backlog in small batches
- ✓ pruneRawUploads › keeps the readings that came from a pruned upload
- ✓ pruneRawUploads › refuses a retention that would delete almost everything

</details>

### `quantity.test.ts`: قراءة الأرقام بدقة

- **إيه ده:** بيجرب قراءة أرقام زي `12.3455` و`1e3` و`NaN` والتقريب لأقرب جزء من ألف بدون أخطاء floating.
- **ليه مهم:** لو الرقم غلط بجزء صغير، السلسلة تنكسر.
- **النتيجة:** 35 من 35 نجحوا

<details><summary>الاختبارات واحد واحد</summary>

- ✓ parseMilli › parses "12.3456"
- ✓ parseMilli › parses "12.3454"
- ✓ parseMilli › parses "12.3455"
- ✓ parseMilli › parses "0.0005"
- ✓ parseMilli › parses "-0.0005"
- ✓ parseMilli › parses "-0.0004"
- ✓ parseMilli › parses "1000"
- ✓ parseMilli › parses "  7.5 "
- ✓ parseMilli › parses "+3"
- ✓ parseMilli › parses ".5"
- ✓ parseMilli › parses "31790.0"
- ✓ parseMilli › parses 37
- ✓ parseMilli › parses 1.0005
- ✓ parseMilli › parses 0.30000000000000004
- ✓ parseMilli › parses 1e-7
- ✓ parseMilli › rejects ""
- ✓ parseMilli › rejects "  "
- ✓ parseMilli › rejects "NaN"
- ✓ parseMilli › rejects "Infinity"
- ✓ parseMilli › rejects "-Infinity"
- ✓ parseMilli › rejects "1e3"
- ✓ parseMilli › rejects "1E3"
- ✓ parseMilli › rejects "1,5"
- ✓ parseMilli › rejects "1 000"
- ✓ parseMilli › rejects "0x10"
- ✓ parseMilli › rejects "--1"
- ✓ parseMilli › rejects "1."
- ✓ parseMilli › rejects "abc"
- ✓ parseMilli › rejects "12.3.4"
- ✓ parseMilli › rejects non-finite and huge numbers
- ✓ parseMilli › never returns negative zero
- ✓ formatting › writes three decimals and keeps the sign
- ✓ formatting › round-trips through the JSON number
- ✓ formatting › rejects a non-integer thousandths value
- ✓ roundMilli › rounds half away from zero to two decimals and leaves three decimals alone

</details>

### `result.test.ts`: معالجة رد MoEnergy

- **إيه ده:** بيجرب كل رد ممكن: 200، تكرار، سلسلة مكسورة، قراءة سيئة، 409/429/5xx، 401/403/413، 422 بأشكال غريبة.
- **ليه مهم:** يحدد إيه اللي يتعمل بعد كل رد (يتعيد، يتعزل، التانك يتحجز).
- **النتيجة:** 41 من 41 نجحوا

<details><summary>الاختبارات واحد واحد</summary>

- ✓ success › closes the batch as accepted when accepted_count equals the item count
- ✓ success › keeps the batch open when accepted_count does not match, or there is no body
- ✓ success › treats a stored duplicate at the first item as the confirmation of a lost reply
- ✓ a broken chain › holds only that tank, sends the others, and resumes after an anchor
- ✓ one bad item › quarantines it, re-chains the tank behind it, and keeps everything before it
- ✓ one bad item › also holds the tank when the rejected reading was a refill (negative consumed)
- ✓ one bad item › treats a stored duplicate in the middle of the batch as a broken chain, not a lost reply
- ✓ one bad item › records the reason when a rejected refill stops the tank
- ✓ a refusal that keeps coming back › stops setting readings aside after the breaker limit and asks for a person
- ✓ a refusal that keeps coming back › counts only this station, and only recent refusals
- ✓ a count that does not add up › confirms only item 0 of a later "stored duplicate", never the whole batch (F4, F6)
- ✓ a count that does not add up › lets the client release a batch it cannot resolve; asking twice answers the same (F6)
- ✓ what MoEnergy said is kept › records every result posted: retryable answers, the closing one, a replay and a refused one
- ✓ what MoEnergy said is kept › cannot be edited afterwards
- ✓ what MoEnergy said is kept › keeps a result whose body PostgreSQL cannot store as JSON, without the body
- ✓ the correlation id › refuses a result that names another send, and changes nothing
- ✓ the correlation id › accepts the result when it names this send
- ✓ answers that change nothing › keeps the batch open on 409 and asks for the same body again
- ✓ answers that change nothing › keeps the batch open on 429 and asks for the same body again
- ✓ answers that change nothing › keeps the batch open on 500 and asks for the same body again
- ✓ answers that change nothing › keeps the batch open on 502 and asks for the same body again
- ✓ answers that change nothing › keeps the batch open on 503 and asks for the same body again
- ✓ answers that change nothing › keeps the batch open on 401 and says the fix is on the client side
- ✓ answers that change nothing › keeps the batch open on 403 and says the fix is on the client side
- ✓ answers that change nothing › keeps the batch open on 413 and says the fix is on the client side
- ✓ answers that change nothing › keeps the batch open on a status nobody planned for
- ✓ answers that change nothing › keeps the batch open on a 422 with a string, and touches nothing
- ✓ answers that change nothing › keeps the batch open on a 422 with null, and touches nothing
- ✓ answers that change nothing › keeps the batch open on a 422 with no errors list, and touches nothing
- ✓ answers that change nothing › keeps the batch open on a 422 with an empty errors list, and touches nothing
- ✓ answers that change nothing › keeps the batch open on a 422 with an error without item_index, and touches nothing
- ✓ answers that change nothing › keeps the batch open on a 422 with an item_index past the end, and touches nothing
- ✓ answers that change nothing › keeps the batch open on a 422 with a negative item_index, and touches nothing
- ✓ repeats and mistakes › answers a repeated identical result with the same outcome and no second effect
- ✓ repeats and mistakes › refuses a different result for a batch that is already closed
- ✓ repeats and mistakes › refuses a result for a batch that does not exist
- ✓ repeats and mistakes › acts once when the same result arrives from several places at once
- ✓ repeats and mistakes › stations are independent › treats another station's batch id as not found and changes nothing
- ✓ repeats and mistakes › stations are independent › a rejection at one station leaves another station's open batch alone
- ✓ which refusals count as a refused refill › a refill reading refused for another field is an ordinary bad item: nothing held, nothing learned
- ✓ which refusals count as a refused refill › a refill refused on consumed_quantity holds the tank and is remembered

</details>

### `rules.test.ts`: قواعد التحقق من القراءة

- **إيه ده:** بيجرب كل قاعدة من الـ guide: السعة، الماء، الارتفاع، الوقت (أقصاه 5 دقايق قدام)، الحرارة.
- **ليه مهم:** قراءة مخالفة بتتعزل قبل ما تتبعت.
- **النتيجة:** 14 من 14 نجحوا

<details><summary>الاختبارات واحد واحد</summary>

- ✓ validateReading › passes the guide-shaped sample reading
- ✓ validateReading › volume_missing: no litre volume, and nothing else is checked
- ✓ validateReading › volume_above_capacity: measured volume over capacity
- ✓ validateReading › volume_above_capacity: an anchor above capacity is caught through the chained fuel_quantity
- ✓ validateReading › consumed_above_fuel: consumed larger than the fuel it comes from
- ✓ validateReading › consumed_above_fuel: a negative measured volume on a first reading
- ✓ validateReading › water_not_below_fuel: water equal to or above fuel fails, strictly
- ✓ validateReading › water_not_below_fuel: compares against the chained fuel, not the measured volume
- ✓ validateReading › water_not_below_fuel: an empty tank (0 and 0) fails and is flagged tank_empty
- ✓ validateReading › fuel_height_above_total: height over the tank height fails, equal passes
- ✓ validateReading › water_height_too_large: 10,000,000 or more fails
- ✓ validateReading › timestamp_in_future: more than 5 minutes ahead fails, exactly 5 passes
- ✓ validateReading › temperature: out of range is dropped and flagged, absent stays absent, bounds are inclusive
- ✓ validateReading › reports every broken rule at once, in a stable order

</details>

### `schema.test.ts`: قيود الـ database

- **إيه ده:** بيتأكد إن الـ database نفسها بترفض البيانات الغلط (أكواد مكررة، إحداثيات برّه السعودية، سلسلة غلط)، وإن الدفعة المقبولة ما تتعدلش.
- **ليه مهم:** خط دفاع أخير لو التطبيق غلط.
- **النتيجة:** 27 من 27 نجحوا

<details><summary>الاختبارات واحد واحد</summary>

- ✓ stations › rejects the same operator code ignoring case
- ✓ stations › rejects coordinates outside Saudi Arabia
- ✓ stations › rejects a city that is not inside the given region, accepts one that is
- ✓ stations › rejects an address over 250 characters
- ✓ stations › rejects a malformed MoEnergy code and a duplicate one
- ✓ tanks › rejects zero capacity, zero height, and a repeated probe number
- ✓ tanks › rejects an unknown product
- ✓ raw_uploads › refuses to edit the payload but allows parse bookkeeping
- ✓ readings › rejects a second reading with the same tank and device time
- ✓ readings › dedupes by content hash when there is no device time
- ✓ readings › requires either a device time or a content hash
- ✓ emitted_readings › enforces remaining = fuel - consumed within 1 L
- ✓ emitted_readings › rejects consumed above fuel
- ✓ emitted_readings › rejects a repeated sequence number for a tank
- ✓ batches and anchors › allows one open batch per station, not one overall
- ✓ batches and anchors › refuses an open batch that names no station
- ✓ batches and anchors › rejects a batch of 1 MB or more
- ✓ batches and anchors › keeps anchors append-only
- ✓ quarantine › keeps one row per reading and rule
- ✓ what the database now guards › makes the emitted readings of an accepted batch immutable
- ✓ what the database now guards › still lets the readings of an open batch be released and unsent ones be removed
- ✓ what the database now guards › never lets a closed batch change or reopen, and keeps closed_at in step with the status
- ✓ what the database now guards › demands an exact chain and no negative stock in the emitted readings
- ✓ what the database now guards › refuses a city without a region, and a registered station or tank without its MoEnergy codes
- ✓ what the database now guards › keeps raw_uploads.body_bytes equal to the stored bytes
- ✓ what the database now guards › keeps a tank hold and its reason together
- ✓ what the database now guards › lets a raw upload be pruned without losing the readings that came from it

</details>

### `send-from.test.ts`: وقت بدء الإرسال (send_from)

- **إيه ده:** بيتأكد إن القراءات قبل وقت التشغيل ما تتبعتش لـ MoEnergy.
- **ليه مهم:** عشان شهور الخزين القديم على الكنترولر ما تغرقش MoEnergy.
- **النتيجة:** 6 من 6 نجحوا

<details><summary>الاختبارات واحد واحد</summary>

- ✓ step with a go-live time (notBefore) › skips a reading before it and leaves the chain where it was
- ✓ step with a go-live time (notBefore) › chains a reading exactly at it, as the start of the chain
- ✓ step with a go-live time (notBefore) › skips a reading before it even when the tank is held: it could never be sent
- ✓ processTank with tanks.send_from › does not send a controller backlog older than the go-live time, and says why
- ✓ processTank with tanks.send_from › keeps sending everything for a tank that has no go-live time
- ✓ processTank with tanks.send_from › applies to a backlog that arrives in two uploads

</details>

### `serialize.test.ts`: شكل الـ JSON الخارج

- **إيه ده:** بيتأكد إن جسم الدفعة طابق مثال الـ guide بالحرف: ترتيب الحقول، الأنواع، بدون خصائص زيادة.
- **ليه مهم:** MoEnergy بترفض أي خاصية غير معروفة.
- **النتيجة:** 9 من 9 نجحوا

<details><summary>الاختبارات واحد واحد</summary>

- ✓ serialize › reproduces the guide's sample body exactly, including field order
- ✓ serialize › gives every field the same JSON type as the guide sample
- ✓ serialize › omits temperature when there is none, and keeps the other fields in order
- ✓ serialize › writes quantities as plain JSON numbers with no float noise
- ✓ serialize › writes a refill as a negative consumed quantity
- ✓ serialize › never lets an unknown property through
- ✓ serialize › formats the time in UTC without milliseconds when they are zero
- ✓ serialize › counts bytes the way the body grows (item plus a comma, multi-byte safe)
- ✓ serialize › serialises an empty batch

</details>

### `sim.charts.test.ts`: جداول معايرة المحاكاة

- **إيه ده:** بيتأكد إن جداول معايرة أول محطة بتتقرا وتتحول من ارتفاع للترات صح.
- **ليه مهم:** أساس المحاكاة.
- **النتيجة:** 8 من 8 نجحوا

<details><summary>الاختبارات واحد واحد</summary>

- ✓ rng › gives the same sequence for the same seed and a different one for another seed
- ✓ rng › draws integers inside the inclusive range
- ✓ rng › draws a Poisson count whose mean is close to lambda
- ✓ calibration charts (the real ones of the first station) › reads CRLF files: heights in 0.1 mm, volumes in litres
- ✓ calibration charts (the real ones of the first station) › interpolates linearly between two chart lines
- ✓ calibration charts (the real ones of the first station) › is zero at the bottom and capped at the top
- ✓ calibration charts (the real ones of the first station) › is inverted by heightMmAt to within a tenth of a millimetre
- ✓ calibration charts (the real ones of the first station) › knows the five capacities the data showed

</details>

### `sim.csv.test.ts`: كتابة ملف CSV المحاكي

- **إيه ده:** بيتأكد إن الملف المولّد مطابق لصيغة ملف الكنترولر الحقيقي.
- **ليه مهم:** عشان المحاكاة تختبر المستورد الحقيقي.
- **النتيجة:** 3 من 3 نجحوا

<details><summary>الاختبارات واحد واحد</summary>

- ✓ TANKMSR.CSV writer › writes the header the real controller writes
- ✓ TANKMSR.CSV writer › writes a record with litres exactly like a real row of tank 1
- ✓ TANKMSR.CSV writer › writes a record without a chart exactly like a real early row

</details>

### `sim.fake.test.ts`: MoEnergy الوهمي

- **إيه ده:** بيتأكد إن المحاكي الصارم المكتوب مستقلاً من قواعد الـ guide بيرفض نفس اللي هيرفضه الحقيقي.
- **ليه مهم:** لو المحاكي متساهل، الاختبارات اللي بعده ما لهاش قيمة.
- **النتيجة:** 18 من 18 نجحوا

<details><summary>الاختبارات واحد واحد</summary>

- ✓ StrictMoEnergy (the rules of the guide, written again independently) › accepts a good batch and chains the next one from its remaining quantity
- ✓ StrictMoEnergy (the rules of the guide, written again independently) › refuses an unknown property, naming the item and the field
- ✓ StrictMoEnergy (the rules of the guide, written again independently) › refuses fuel above the tank capacity, naming the item and the field
- ✓ StrictMoEnergy (the rules of the guide, written again independently) › refuses consumed above fuel, naming the item and the field
- ✓ StrictMoEnergy (the rules of the guide, written again independently) › refuses water not below fuel, naming the item and the field
- ✓ StrictMoEnergy (the rules of the guide, written again independently) › refuses fuel height above the tank height, naming the item and the field
- ✓ StrictMoEnergy (the rules of the guide, written again independently) › refuses a time more than 5 minutes ahead, naming the item and the field
- ✓ StrictMoEnergy (the rules of the guide, written again independently) › refuses a time without an offset, naming the item and the field
- ✓ StrictMoEnergy (the rules of the guide, written again independently) › refuses remaining that is not fuel minus consumed, naming the item and the field
- ✓ StrictMoEnergy (the rules of the guide, written again independently) › refuses a temperature out of range, naming the item and the field
- ✓ StrictMoEnergy (the rules of the guide, written again independently) › refuses an unknown tank, naming the item and the field
- ✓ StrictMoEnergy (the rules of the guide, written again independently) › accepts remaining within one litre of fuel minus consumed
- ✓ StrictMoEnergy (the rules of the guide, written again independently) › reports a broken chain at the item where fuel is not the previous remaining
- ✓ StrictMoEnergy (the rules of the guide, written again independently) › reports a duplicate before a broken chain
- ✓ StrictMoEnergy (the rules of the guide, written again independently) › stores nothing from a batch with one bad item, and reports only the first bad one
- ✓ StrictMoEnergy (the rules of the guide, written again independently) › refuses a negative consumed quantity only when it is told to
- ✓ StrictMoEnergy (the rules of the guide, written again independently) › refuses a tank whose items are not in time order
- ✓ StrictMoEnergy (the rules of the guide, written again independently) › refuses a body over 1 MB

</details>

### `sim.model.test.ts`: مولّد المحطات

- **إيه ده:** بيتأكد إن المحطات المولّدة شبه الحقيقية: حوالي 100 سجل يومياً، تعبئات، انقطاعات، وأعطال الداتا الحقيقية.
- **ليه مهم:** الداتا الصناعية لازم تكون واقعية.
- **النتيجة:** 15 من 15 نجحوا

<details><summary>الاختبارات واحد واحد</summary>

- ✓ generateStation: shape of the data › gives the same records for the same seed and other records for another seed
- ✓ generateStation: shape of the data › stores about a hundred records a day for a five-tank station, like the real controller
- ✓ generateStation: shape of the data › keeps every record of a tank in strictly increasing time when there are no faults
- ✓ generateStation: shape of the data › keeps volume, ullage and water consistent with the tank chart: volume + ullage + water = capacity
- ✓ generateStation: shape of the data › formats the stamped time as the controller does, local and without a zone
- ✓ generateStation: shape of the data › sells about the configured litres a day per tank
- ✓ generateStation: refills, outages, tanks without a chart › shows each refill as one big rise between two records, and counts them
- ✓ generateStation: refills, outages, tanks without a chart › counts only the refills that two records with litres show, also when the first days have no chart
- ✓ generateStation: refills, outages, tanks without a chart › writes nothing while the controller is away and then shows the difference
- ✓ generateStation: refills, outages, tanks without a chart › writes no litre values while a tank has no chart, as the real controller did until early September
- ✓ generateStation: the faults of the real data › injects nothing when no fault is asked for
- ✓ generateStation: the faults of the real data › stamps a burst of rows exactly 00:00:00 and never lets a normal record take that time
- ✓ generateStation: the faults of the real data › writes pairs of records with the same tank and second but different values
- ✓ generateStation: the faults of the real data › adds small rises of 1 to 5 litres on an idle tank
- ✓ generateStation: the faults of the real data › adds probe glitches that read 0 litres at 0 mm

</details>

### `sim.run.test.ts`: تشغيل السيناريو الكامل

- **إيه ده:** بيشغل محطات مولّدة عبر المستورد والـ ledger والدفعات وMoEnergy الوهمي، ويتأكد إن الفحوصات النهائية كلها تعدي، وإن الفاحص نفسه مش أعمى.
- **ليه مهم:** أقرب اختبار للواقع قبل أول كنترولر.
- **النتيجة:** 8 من 8 نجحوا

<details><summary>الاختبارات واحد واحد</summary>

- ✓ runScenario: simulated stations through importer, ledger, batches and a strict MoEnergy › a clean fortnight passes every invariant, refills included
- ✓ runScenario: simulated stations through importer, ledger, batches and a strict MoEnergy › the faults of the real data are all accounted for: set aside, never sent, nothing lost
- ✓ runScenario: simulated stations through importer, ledger, batches and a strict MoEnergy › survives an outage of a few days and tanks without a chart at the start
- ✓ runScenario: simulated stations through importer, ledger, batches and a strict MoEnergy › when MoEnergy refuses negative consumed, a refilled tank is held once and the run ends
- ✓ runScenario: simulated stations through importer, ledger, batches and a strict MoEnergy › gives the same numbers for the same seed
- ✓ runScenario: simulated stations through importer, ledger, batches and a strict MoEnergy › the checker is not blind: a hole in the chain at MoEnergy is found
- ✓ runScenario: simulated stations through importer, ledger, batches and a strict MoEnergy › the checker is not blind: a reading stored at a time the data never had is found
- ✓ runScenario: simulated stations through importer, ledger, batches and a strict MoEnergy › the checker is not blind: a clock_invalid reading that reached a batch is found

</details>

### `stations.load.test.ts`: تحميل المحطات من CSV

- **إيه ده:** بيجرب قراءة الملف ورفض الأكواد الغلط والسعة صفر…، وتحميل المحطات وإعطاء كل محطة سر رفع مرة واحدة.
- **ليه مهم:** هو اللي هنحمّل بيه المحطات الحقيقية.
- **النتيجة:** 22 من 22 نجحوا

<details><summary>الاختبارات واحد واحد</summary>

- ✓ parseStationsCsv › reads one row per tank, with quoted names, empty optional columns and a CRLF file
- ✓ parseStationsCsv › accepts columns in any order and in any letter case
- ✓ parseStationsCsv › refuses a file that lacks a required column, naming it
- ✓ parseStationsCsv › refuses a station code with characters that do not belong in a URL
- ✓ parseStationsCsv › refuses a station code that is not ST-000000
- ✓ parseStationsCsv › refuses a tank code of another station
- ✓ parseStationsCsv › refuses a tank code that does not end with a number
- ✓ parseStationsCsv › refuses a product MoEnergy does not list
- ✓ parseStationsCsv › refuses a capacity of zero
- ✓ parseStationsCsv › refuses a capacity with four decimals
- ✓ parseStationsCsv › refuses a height of zero
- ✓ parseStationsCsv › refuses a tank number that is not a positive integer
- ✓ parseStationsCsv › refuses a time zone out of range
- ✓ parseStationsCsv › refuses a go-live time without an offset
- ✓ parseStationsCsv › refuses the same tank twice, two codes for one station, and one MoEnergy code for two stations
- ✓ parseStationsCsv › reports every bad line, not just the first
- ✓ loadStations › creates the stations and their tanks, loads the reference products, and gives each new station its upload secret
- ✓ loadStations › does nothing the second time, and shows no secret again
- ✓ loadStations › adds the tanks and stations that are new when the file grows
- ✓ loadStations › refuses a file that disagrees with what is stored, and writes nothing from it, unless told to update
- ✓ loadStations › refuses a different MoEnergy code for a station that has one, and a code another station already uses
- ✓ loadStations › shows what it would do and writes nothing in a dry run

</details>

### `status.test.ts`: حالة المحطة (status)

- **إيه ده:** بيتأكد إن `/status` بيوصف المحطة والتانكات (المحجوز، المنتظر الأكواد، المعزول) وإنه بيقرا بس.
- **ليه مهم:** هو اللي استخدمناه على السيرفر الحقيقي.
- **النتيجة:** 6 من 6 نجحوا

<details><summary>الاختبارات واحد واحد</summary>

- ✓ GET /v1/stations/{code}/status › needs a key, and a station the key may use
- ✓ GET /v1/stations/{code}/status › describes the station and each tank: codes, go-live time, what waits, what was sent
- ✓ GET /v1/stations/{code}/status › shows a held tank with the reason, and a tank that still lacks its MoEnergy code
- ✓ GET /v1/stations/{code}/status › counts what was set aside, by rule
- ✓ GET /v1/stations/{code}/status › does not run the ledger or change anything: it only reads
- ✓ GET /v1/stations/{code}/status › follows a reading through the open batch to sent

</details>
