// All app state and actions, independent of Android and Compose (port of web/src/app/session.ts). The UI collects
// `state` and calls these methods; nothing here touches a view.
package app.airlock.android.session

import app.airlock.android.engines.DownloadEvent
import app.airlock.android.store.StoredOutcome
import app.airlock.android.store.StoredSealed
import app.airlock.android.store.StoredTurn
import app.airlock.android.store.TaskDto
import app.airlock.android.store.ThreadRecord
import app.airlock.android.store.routeOf
import app.airlock.core.ANALYSIS_OPTIONS
import app.airlock.core.Action
import app.airlock.core.AnswerEvent
import app.airlock.core.AnswerOutcome
import app.airlock.core.AnswerRequest
import app.airlock.core.Answers
import app.airlock.core.ChainVerification
import app.airlock.core.EgressGate
import app.airlock.core.EngineError
import app.airlock.core.EngineErrorCode
import app.airlock.core.EntityMap
import app.airlock.core.GateBlocked
import app.airlock.core.GateHit
import app.airlock.core.LedgerStats
import app.airlock.core.PhoneAvailability
import app.airlock.core.PhonePrompt
import app.airlock.core.PlaceholderId
import app.airlock.core.Receipt
import app.airlock.core.ReceiptLedger
import app.airlock.core.RedTeam
import app.airlock.core.RestoreContext
import app.airlock.core.RestoredSegment
import app.airlock.core.Restorer
import app.airlock.core.Risk
import app.airlock.core.SealDraft
import app.airlock.core.SealPipeline
import app.airlock.core.SealProgress
import app.airlock.core.SealResult
import app.airlock.core.SealSettings
import app.airlock.core.SealedHistory
import app.airlock.core.SealedText
import app.airlock.core.SealedTurn
import app.airlock.core.TaskKind
import app.airlock.core.UserOverride
import app.airlock.core.VaultEntry
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.Instant
import java.util.UUID

enum class Screen { ONBOARDING, ASK, REVIEW, THREAD, LEDGER, VAULT, SETTINGS }

/** One conversation turn. User turns keep what was written locally; only `sealed` can ever be sent again. */
sealed interface Turn {
    data class User(
        /** What the user wrote — shown locally only. */
        val raw: String,
        /** The sealed text as it left (for display). */
        val display: String,
        /** Gate-checked sealed text for follow-up history; null if a reloaded turn no longer passes the gate. */
        val sealed: SealedText?,
        val stored: StoredSealed,
    ) : Turn

    data class Assistant(
        val task: TaskKind,
        val status: Status,
        val text: String,
        val segments: List<RestoredSegment>,
        val outcome: AnswerOutcome?,
        val error: EngineErrorCode?,
    ) : Turn

    enum class Status { STREAMING, DONE, ERROR }
}

data class Thread(val id: String, val title: String, val task: TaskKind, val entities: EntityMap, val turns: List<Turn>, val createdAt: Long) {
    val busy: Boolean get() = turns.any { it is Turn.Assistant && it.status == Turn.Status.STREAMING }
}

data class Review(
    val raw: String,
    val task: TaskKind,
    val threadId: String?,
    val progress: SealProgress?,
    val result: SealResult?,
    val overrides: Map<PlaceholderId, UserOverride>,
    val accepted: List<Risk>,
    val dismissed: Set<Int>,
    val blocked: List<GateHit>?,
    /** The on-device read failed outright; nothing was sent. */
    val failed: Boolean,
    /** `System.nanoTime()` when sealing started (elapsed timer). */
    val startedAtNanos: Long,
)

data class State(
    val screen: Screen,
    val prefs: Prefs,
    /** Null while checking. */
    val availability: PhoneAvailability?,
    val downloadProgress: Float?,
    val downloading: Boolean,
    val vault: List<VaultEntry>,
    val threads: List<Thread>,
    val currentThreadId: String?,
    val review: Review?,
    val chain: ChainVerification?,
    val receipts: List<Receipt>,
    /** Ask's text box (also filled from the Android share sheet). */
    val draft: String,
    val draftFromShare: Boolean,
    val loaded: Boolean,
)

class AirlockSession(val services: Services, private val scope: CoroutineScope) {
    private val initialPrefs = services.prefs.load() ?: Prefs(dial = services.config.dialDefault)
    private val _state = MutableStateFlow(
        State(
            screen = if (initialPrefs.onboarded) Screen.ASK else Screen.ONBOARDING, prefs = initialPrefs, availability = null, downloadProgress = null,
            downloading = false, vault = emptyList(), threads = emptyList(), currentThreadId = null, review = null, chain = null, receipts = emptyList(),
            draft = "", draftFromShare = false, loaded = false,
        ),
    )
    val state: StateFlow<State> = _state.asStateFlow()
    val current: State get() = _state.value

    var ledger: ReceiptLedger = newLedger(emptyList())
        private set

    private fun newLedger(receipts: List<Receipt>) = ReceiptLedger(receipts) { r -> services.stores.saveReceipt(r) }

    /** Runs a long action (seal, send, download) in the session's scope, so leaving a screen doesn't cancel it. */
    fun run(block: suspend AirlockSession.() -> Unit) = scope.launch { block() }

    private fun set(f: (State) -> State) = _state.update(f)
    private fun setReview(f: (Review) -> Review) = set { s -> s.review?.let { s.copy(review = f(it)) } ?: s }
    private fun setThread(id: String, f: (Thread) -> Thread) = set { s -> s.copy(threads = s.threads.map { if (it.id == id) f(it) else it }) }

    suspend fun load() {
        val vault = services.stores.loadVault()
        ledger = newLedger(services.stores.receipts())
        val threads = loadThreads(vault)
        set { it.copy(vault = vault, threads = threads, receipts = ledger.receipts, loaded = true) }
        services.stores.purgeCaptures(services.config.rawPurgeDays)
        refreshAvailability()
    }

    suspend fun refreshAvailability() {
        val a = try {
            services.availability()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            PhoneAvailability.UNAVAILABLE
        }
        set { it.copy(availability = a) }
    }

    /** "Download on-device model": starts Gemini Nano's download and tracks progress. */
    suspend fun enableOnDevice() {
        val download = services.download ?: return
        set { it.copy(downloading = true, downloadProgress = null) }
        try {
            download().collect { ev ->
                when (ev) {
                    is DownloadEvent.Progress -> set { it.copy(downloadProgress = ev.fraction) }
                    else -> {}
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Reflected by the availability check below.
        }
        set { it.copy(downloading = false, downloadProgress = null) }
        refreshAvailability()
    }

    fun go(screen: Screen) = set { it.copy(screen = screen) }
    fun openThread(id: String) = set { it.copy(currentThreadId = id, screen = Screen.THREAD) }

    fun setPrefs(f: (Prefs) -> Prefs) {
        val p = f(current.prefs)
        runCatching { services.prefs.save(p) }
        set { it.copy(prefs = p) }
    }

    fun finishOnboarding() {
        setPrefs { it.copy(onboarded = true) }
        go(Screen.ASK)
    }

    fun setDraft(text: String, fromShare: Boolean = false) = set { it.copy(draft = text, draftFromShare = fromShare && text.isNotEmpty()) }

    /** Text shared from another app lands in Ask's box; nothing is read until the user taps Seal. */
    fun receiveShared(text: String) {
        setDraft(text, fromShare = true)
        if (current.prefs.onboarded) set { it.copy(screen = Screen.ASK, review = null) }
    }

    // MARK: Vault
    fun saveVault(vault: List<VaultEntry>) {
        services.stores.saveVault(vault)
        set { it.copy(vault = vault) }
    }

    // MARK: Seal
    private fun pipeline(): SealPipeline {
        val c = services.config
        val settings = SealSettings(dial = current.prefs.dial, chunkTokens = c.detectChunkTokens, today = Instant.now(), redTeamEnabled = c.redTeamEnabled, redTeamRounds = c.redTeamRounds)
        return SealPipeline(services.engines.phone, services.patterns, current.vault, services.prompts, settings)
    }

    /** Ask → Review: detection, policy, sealing and red-team, all on the device. Suspends until the red-team is done. */
    suspend fun startReview(raw: String, task: TaskKind, threadId: String? = null) {
        val text = raw.trim()
        if (text.isEmpty()) return
        val source = if (threadId != null) "followUp" else if (current.draftFromShare) "share" else "paste"
        set {
            it.copy(
                screen = Screen.REVIEW,
                review = Review(text, task, threadId, null, null, emptyMap(), emptyList(), emptySet(), null, false, System.nanoTime()),
            )
        }
        runCatching { services.stores.saveCapture(text, source, threadId) }
        val existing = threadId?.let { id -> current.threads.firstOrNull { it.id == id }?.entities }
        val staged = try {
            pipeline().runStaged(scope, text, existing ?: EntityMap(), emptyMap()) { p -> setReview { r -> r.copy(progress = p) } }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            setReview { it.copy(failed = true) }
            return
        }
        val result = staged.result
        setReview { it.copy(result = result, accepted = result.acceptedRisks) }
        val later = staged.later ?: return
        // Balanced: the red-team finishes while the user reads the draft. Their chip edits are re-applied on top.
        val full = try {
            later.await()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            result.copy(redTeamPending = false, redTeamUnavailable = true)
        }
        val r = current.review
        if (r?.result == null || r.result.normalised != result.normalised) return
        setReview { it.copy(result = pipeline().reseal(full, it.overrides, it.accepted)) }
    }

    private var warmed = false

    /** Loads Gemini Nano ahead of the first seal (once per process; no user text involved). */
    fun warmUp() {
        if (warmed || current.availability != PhoneAvailability.AVAILABLE || services.mode != AppMode.LIVE) return
        val w = services.warmUp ?: return
        warmed = true
        scope.launch { runCatching { w() } }
    }

    private fun reseal(overrides: Map<PlaceholderId, UserOverride>, accepted: List<Risk>) {
        val r = current.review ?: return
        val res = r.result ?: return
        val next = pipeline().reseal(res, overrides, accepted)
        setReview { it.copy(result = next, overrides = overrides, accepted = accepted, blocked = null) }
    }

    /** Chip/list toggle: send as written ↔ protect. Vault entries need the explicit "reveal this time" flag. */
    fun toggleEntity(id: PlaceholderId) {
        val r = current.review ?: return
        val e = r.result?.draft?.entities?.get(id) ?: return
        if (e.category == app.airlock.core.PrivacyCategory.SECRET) return
        val overrides = HashMap(r.overrides)
        overrides[id] = if (e.action is Action.Keep) UserOverride(Action.Placeholder, false) else UserOverride(Action.Keep, e.vaultEntryId != null)
        reseal(overrides, r.accepted)
    }

    fun acceptRisk(risk: Risk) {
        val r = current.review ?: return
        reseal(r.overrides, r.accepted.filter { it.id != risk.id } + risk)
    }

    fun dismissRisk(risk: Risk) = setReview { it.copy(dismissed = it.dismissed + risk.id) }

    fun pendingRisks(r: Review? = current.review): List<Risk> {
        val res = r?.result ?: return emptyList()
        val accepted = r.accepted.mapTo(HashSet()) { it.id }
        return res.risks.filter { it.id !in accepted && it.id !in r.dismissed }
    }

    fun setReviewTask(task: TaskKind) = setReview { it.copy(task = task) }

    fun clearBlocked() = setReview { it.copy(blocked = null) }

    fun cancelReview() {
        val back = if (current.review?.threadId != null) Screen.THREAD else Screen.ASK
        set { it.copy(review = null, screen = back) }
    }

    /** Seal & send: the egress gate is the only way out. Returns false if the gate blocked or sending is not allowed yet. */
    suspend fun send(): Boolean {
        val r = current.review ?: return false
        val result = r.result ?: return false
        if (result.redTeamPending == true) return false
        val gate = EgressGate(services.patterns, current.vault)
        val draft = RedTeam.applyRisks(r.accepted, result.draft)
        val sealed = try {
            gate.seal(draft)
        } catch (e: GateBlocked) {
            setReview { it.copy(blocked = e.hits) }
            return false
        }
        val entities = result.draft.entities
        var threadId = r.threadId
        val isNew = threadId == null
        if (threadId == null) {
            threadId = UUID.randomUUID().toString()
            val t = Thread(threadId, titleFrom(sealed.value), r.task, entities, emptyList(), System.currentTimeMillis())
            set { it.copy(threads = listOf(t) + it.threads) }
        }
        runCatching { services.stores.saveEntities(threadId, entities) }
        val history = historyOf(current.threads.firstOrNull { it.id == threadId })
        val stored = StoredSealed(draft.text, StoredSealed.legendOf(draft.legend), draft.revealedVaultIds.toList(), draft.keptValues.toList())
        setThread(threadId) { t ->
            t.copy(
                entities = entities,
                turns = t.turns + Turn.User(r.raw, sealed.value, sealed, stored) + Turn.Assistant(r.task, Turn.Status.STREAMING, "", emptyList(), null, null),
            )
        }
        set { it.copy(review = null, currentThreadId = threadId, screen = Screen.THREAD, draft = if (isNew) "" else it.draft, draftFromShare = false) }
        stream(threadId, sealed, r.task, entities, history, result.sealMs)
        if (isNew) nameThread(threadId, sealed)
        persistThread(threadId)
        return true
    }

    /** On-device title from the *sealed* first message (`title.v1`), so a title can't contain a real name. */
    private suspend fun nameThread(id: String, sealed: SealedText) {
        if (current.availability != PhoneAvailability.AVAILABLE) return
        try {
            val prompt = services.prompts.render("title.v1", mapOf("sealed_first_message" to sealed.value.take(2000)))
            val out = services.engines.phone.respond(PhonePrompt("title.v1", prompt), ANALYSIS_OPTIONS).text
            cleanTitle(out)?.let { title -> setThread(id) { it.copy(title = title) } }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Keep the rule-based title.
        }
    }

    private suspend fun stream(threadId: String, sealed: SealedText, task: TaskKind, entities: EntityMap, history: SealedHistory, sealMs: Double) {
        val me = current.vault.firstOrNull { it.isUser }
        fun updateLast(f: (Turn.Assistant) -> Turn.Assistant) = setThread(threadId) { t ->
            val last = t.turns.lastOrNull()
            if (last is Turn.Assistant) t.copy(turns = t.turns.dropLast(1) + f(last)) else t
        }
        try {
            Answers.answer(
                AnswerRequest(
                    engines = services.engines, prompts = services.prompts, ledger = ledger, sealed = sealed, task = task,
                    history = history.takeIf { it.turns.isNotEmpty() },
                    restore = RestoreContext(entities, userFirstName = me?.canonical?.split(" ")?.firstOrNull()),
                    preference = current.prefs.preference, threadId = threadId, sealMs = sealMs, armorExpected = services.config.armorExpected,
                ),
            ).collect { ev ->
                when (ev) {
                    is AnswerEvent.Partial -> updateLast { it.copy(text = ev.text, segments = ev.segments) }
                    is AnswerEvent.Finished -> updateLast {
                        it.copy(status = Turn.Status.DONE, outcome = ev.outcome, text = ev.outcome.restored.text, segments = ev.outcome.restored.segments)
                    }
                    is AnswerEvent.Started -> {}
                }
            }
        } catch (e: CancellationException) {
            updateLast { it.copy(status = Turn.Status.ERROR, error = EngineErrorCode.CANCELLED) }
            throw e
        } catch (e: Exception) {
            updateLast { it.copy(status = Turn.Status.ERROR, error = (e as? EngineError)?.code ?: EngineErrorCode.OTHER) }
        }
        set { it.copy(receipts = ledger.receipts) }
    }

    // MARK: Saved conversations (encrypted, local only)

    private fun persistThread(id: String) {
        val t = current.threads.firstOrNull { it.id == id } ?: return
        val turns = t.turns.mapNotNull { turn ->
            when (turn) {
                is Turn.User -> StoredTurn(kind = "user", raw = turn.raw, sealed = turn.stored)
                is Turn.Assistant -> if (turn.status == Turn.Status.STREAMING) null else StoredTurn(
                    kind = "assistant", task = TaskDto.of(turn.task), status = if (turn.status == Turn.Status.DONE) "done" else "error",
                    modelText = turn.outcome?.modelText ?: "", error = turn.error?.wire,
                    outcome = turn.outcome?.let { o -> StoredOutcome(o.route.wire, o.modelVersion, o.ranOnDevice, o.fellBackToPhone, o.latencyMs, o.receipt?.id) },
                )
            }
        }
        runCatching {
            services.stores.saveThread(ThreadRecord(1, t.id, t.title, TaskDto.of(t.task), t.createdAt, System.currentTimeMillis(), turns))
        }
    }

    /**
     * Rebuilds saved conversations. Sealed turns are never trusted from storage: each goes back through
     * `EgressGate.seal` (INV-2). A turn that no longer passes (e.g. the Vault changed) is still shown, but it and its
     * answer are left out of the history sent with follow-ups.
     */
    private fun loadThreads(vault: List<VaultEntry>): List<Thread> {
        val gate = EgressGate(services.patterns, vault)
        val me = vault.firstOrNull { it.isUser }
        return services.stores.threads().map { rec ->
            val entities = runCatching { services.stores.loadEntities(rec.id) }.getOrElse { EntityMap() }
            val turns = rec.turns.mapNotNull { st ->
                if (st.kind == "user") {
                    val s = st.sealed ?: return@mapNotNull null
                    val draft = SealDraft(s.text, s.legendLines(), emptyList(), entities, emptyList(), s.revealedVaultIds.toSet(), s.keptValues.toSet())
                    val sealed = try {
                        gate.seal(draft)
                    } catch (_: GateBlocked) {
                        null
                    }
                    Turn.User(st.raw ?: "", s.text, sealed, s)
                } else {
                    val task = st.task?.toTask() ?: TaskKind.Help
                    val modelText = st.modelText ?: ""
                    val ctx = RestoreContext(entities, me?.canonical?.split(" ")?.firstOrNull(), task.writesAsUser)
                    val restored = Restorer.restore(modelText, ctx)
                    val outcome = st.outcome?.let { o ->
                        AnswerOutcome(
                            modelText, restored, Restorer.fidelityCheck(modelText, ctx), routeOf(o.route), o.modelVersion, o.ranOnDevice, o.fellBackToPhone,
                            o.latencyMs, ledger.receipts.firstOrNull { it.id == o.receiptId },
                        )
                    }
                    Turn.Assistant(
                        task, if (st.status == "done") Turn.Status.DONE else Turn.Status.ERROR, restored.text, restored.segments, outcome,
                        st.error?.let { w -> EngineErrorCode.entries.firstOrNull { it.wire == w } },
                    )
                }
            }
            Thread(rec.id, rec.title, rec.task.toTask(), entities, turns, rec.createdAt)
        }
    }

    /** Deletes a conversation, its entity map and captures. Its receipts stay: the chain must stay verifiable. */
    fun deleteThread(id: String) {
        runCatching { services.stores.deleteThread(id) }
        set { s ->
            s.copy(threads = s.threads.filter { it.id != id }).let {
                if (s.currentThreadId == id) it.copy(currentThreadId = null, screen = Screen.ASK) else it
            }
        }
    }

    // MARK: Ledger and data
    fun verifyChain(): ChainVerification {
        val chain = ledger.verify()
        set { it.copy(chain = chain) }
        return chain
    }

    fun stats(days: Int = 7): LedgerStats = ledger.stats(Instant.now().minusSeconds(days * 86_400L))

    /** Settings → Delete everything: Vault, conversations, entity maps, captures, receipts and the key itself. */
    fun deleteEverything() {
        services.stores.deleteEverything()
        ledger = newLedger(emptyList())
        runCatching { services.prefs.clear() }
        val prefs = Prefs(dial = services.config.dialDefault)
        set {
            it.copy(
                vault = emptyList(), threads = emptyList(), currentThreadId = null, review = null, chain = null, receipts = emptyList(), prefs = prefs,
                screen = Screen.ONBOARDING, draft = "", draftFromShare = false,
            )
        }
    }

    companion object {
        /** Accepts a model title only if it is short, plain words, and free of placeholders. */
        fun cleanTitle(out: String): String? {
            val first = out.trim().split("\n").firstOrNull() ?: return null
            val line = first.replace(Regex("^(title:\\s*)", RegexOption.IGNORE_CASE), "")
                .replace(Regex("^[\"'*#\\s]+|[\"'*.\\s]+$"), "").trim()
            if (line.isEmpty() || line.length > 60 || Regex("\\[\\[|_\\d|\\bME\\b|[{}<>]").containsMatchIn(line) || !Regex("\\p{L}").containsMatchIn(line)) return null
            if (line.split(Regex("\\s+")).size > 7) return null
            return line.substring(0, 1).uppercase() + line.substring(1)
        }

        private val NOUNS = mapOf(
            "PERSON" to "someone", "ORG" to "an organisation", "LOC" to "a place", "CONTACT" to "a contact", "ID" to "an ID", "DATE" to "a date",
            "HEALTH" to "a health detail", "SECRET" to "a code",
        )
        private val STOP = Regex("^(a|an|the|at|to|of|and|or|in|on|for|with|my|your)$", RegexOption.IGNORE_CASE)

        /** First few words of the sealed text, placeholders replaced by plain nouns (title.v1 on device refines it). */
        fun titleFrom(sealed: String): String {
            val words = sealed.replace("[[PERSON_ME]]", "me")
                .replace(Regex("\\[\\[([A-Z]+)_\\d+]]")) { NOUNS[it.groupValues[1]] ?: "something" }
                .replace(Regex("[^\\p{L}\\p{N}' ]+"), " ")
                .split(Regex("\\s+")).filter { it.isNotEmpty() }
            val head = words.take(7).toMutableList()
            while (head.size > 1 && STOP.matches(head.last())) head.removeAt(head.size - 1)
            val t = head.joinToString(" ")
            return if (t.isEmpty()) "Sealed request" else t.substring(0, 1).uppercase() + t.substring(1)
        }

        fun historyOf(thread: Thread?): SealedHistory {
            val turns = ArrayList<SealedTurn>()
            var skipAnswer = false
            for (t in thread?.turns.orEmpty()) {
                when (t) {
                    is Turn.User -> {
                        skipAnswer = t.sealed == null
                        t.sealed?.let { turns.add(SealedTurn.User(it)) }
                    }
                    is Turn.Assistant -> if (t.outcome != null && !skipAnswer) turns.add(SealedTurn.Assistant(t.outcome.modelText))
                }
            }
            return SealedHistory(turns)
        }
    }
}
