package app.airlock.core

/** A prompt id is missing, or a `{{variable}}` was left unfilled. Names the id/variable only — never content. */
class PromptError(val id: String, val variable: String? = null) :
    Exception(if (variable != null) "Prompt $id: unfilled {{$variable}}" else "Prompt $id missing")

/**
 * Every prompt by versioned id (port of prompts.ts / PromptLibrary.swift). Bundled prompts are the Swift package's
 * files (classpath `airlock/prompts/`). Remote Config `prompt_overrides_json` replaces prompts by id. [render]
 * substitutes `{{name}}` in a single pass — values (user content) are never re-scanned — and any unfilled
 * placeholder is an error.
 */
class PromptLibrary(overridesJson: String = "{}") {
    private val prompts = LinkedHashMap<String, String>()

    init {
        for (id in BUNDLED_IDS) {
            val text = read("/airlock/prompts/$id.txt") ?: continue
            prompts[id] = if (text.endsWith("\n")) text.substring(0, text.length - 1) else text
        }
        try {
            when (val o = JsJson.parse(overridesJson)) {
                is Map<*, *> -> for ((id, text) in o) if (text is String) prompts[id.toString()] = text
                is List<*> -> o.forEachIndexed { i, text -> if (text is String) prompts[i.toString()] = text }
                else -> {}
            }
        } catch (_: JsonSyntaxError) {
            // Ignore malformed overrides: bundled prompts stay in force.
        }
    }

    fun template(id: String): String = prompts[id] ?: throw PromptError(id)

    fun render(id: String, vars: Map<String, String> = emptyMap()): String {
        val t = template(id)
        val out = StringBuilder(t.length)
        var i = 0
        while (i < t.length) {
            val open = t.indexOf("{{", i)
            if (open < 0) break
            val close = t.indexOf("}}", open + 2)
            if (close < 0) break
            out.append(t, i, open)
            val name = Js.trim(t.substring(open + 2, close))
            out.append(vars[name] ?: throw PromptError(id, name))
            i = close + 2
        }
        return out.append(t, i, t.length).toString()
    }

    /** The cloud user turn (`cloud-user.v1`) with replayed history — only sealed text and the model's own replies. */
    fun cloudUserTurn(sealed: SealedText, task: TaskSpec, history: SealedHistory? = null): String {
        val legend = if (sealed.legend.isEmpty()) "(none)" else sealed.renderedLegend()
        val turn = render("cloud-user.v1", mapOf("legend_lines" to legend, "task_instruction" to task.instruction, "sealed_text" to sealed.value))
        if (history == null || history.turns.isEmpty()) return turn
        val earlier = history.turns.joinToString("\n\n") {
            when (it) {
                is SealedTurn.User -> "User:\n<<<\n${it.sealed.value}\n>>>"
                is SealedTurn.Assistant -> "You replied:\n<<<\n${it.modelText}\n>>>"
            }
        }
        return "Earlier in this conversation (placeholders mean the same things):\n\n$earlier\n\n$turn"
    }

    companion object {
        private fun read(path: String): String? = PromptLibrary::class.java.getResourceAsStream(path)?.use { it.readBytes().toString(Charsets.UTF_8) }

        /** Every bundled prompt id, sorted (from the build-generated `airlock/prompts/index.txt`). */
        val BUNDLED_IDS: List<String> by lazy {
            (read("/airlock/prompts/index.txt") ?: "").split("\n").filter { it.isNotEmpty() }.sorted()
        }
    }
}
