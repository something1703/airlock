package app.airlock.core

/**
 * FX-02: a quick task that never needs the cloud skips the seal and the Review screen (port of local.ts / LocalAnswer.swift).
 * The raw message goes to the phone-only engine and nowhere else (INV-3) — nothing is sent, so there is nothing to check.
 *
 * It applies only when the on-device model is available, the message fits its window, and either the task is a quick one
 * or the user chose "This device only" ("Best answer" always goes to Gemini). Any failure is thrown, so the caller can fall
 * back to the normal seal → Review → gate flow.
 */
object LocalAnswer {
    /** Whether a request is answered on the device with no seal and no Review. */
    fun runsOnDevice(task: TaskKind, preference: AnswerPreference, availability: PhoneAvailability?, rawLength: Int): Boolean {
        if (availability != PhoneAvailability.AVAILABLE || rawLength > Answers.ON_DEVICE_LIMIT || preference == AnswerPreference.BEST) return false
        return preference == AnswerPreference.PHONE_ONLY || task.isQuick
    }

    /** An earlier exchange of the same conversation that also stayed on the device. */
    data class Exchange(val raw: String, val answer: String)

    data class Result(val text: String, val modelVersion: String, val latencyMs: Double)

    /** At most this many characters of earlier exchanges go in front of a follow-up (the on-device window is small). */
    private const val EARLIER_BUDGET = 3_000

    /** One on-device answer from the raw message (`phone-local.v1`). Throws [EngineError]. */
    suspend fun run(phone: PhoneOnlyEngine, prompts: PromptLibrary, task: TaskKind, raw: String, earlier: List<Exchange> = emptyList()): Result {
        val turn = prompts.render("phone-local.v1", mapOf("task_instruction" to Answers.taskSpec(prompts, task).instruction, "text" to raw))
        val kept = ArrayList<String>()
        var used = 0
        for (x in earlier.asReversed()) {
            val block = "User:\n<<<\n${x.raw}\n>>>\n\nYou replied:\n<<<\n${x.answer}\n>>>"
            if (used + block.length > EARLIER_BUDGET) break
            kept.add(0, block)
            used += block.length
        }
        val text = if (kept.isEmpty()) turn else "Earlier in this conversation:\n\n${kept.joinToString("\n\n")}\n\n$turn"
        val r = phone.respond(PhonePrompt("phone-local.v1", text), PhoneOptions(greedy = false))
        val answer = Js.trim(r.text)
        if (answer.isEmpty()) throw EngineError(EngineErrorCode.OTHER, "empty-answer")
        return Result(answer, r.modelVersion, r.latencyMs)
    }
}
