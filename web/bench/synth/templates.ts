// Sentence templates for `synth-tpl.v1`: 10 document types × 3 languages (docs/04-PROMPTS.md §9 doc types).
// `{slot}` markers are filled by synth.ts, which records every private value it inserts as a gold span.
import type { BenchTaskKind, Language } from "../dataset";
import type { LanguageParts } from "./parts";

export type OrgSource = "employer" | "landlords" | "insurers" | "clinics" | "schools" | "banks" | "recruiters";
export type ExtraSlot = "contact" | "id" | "dob" | "otp" | "password" | "health" | "iban" | "third";

export interface DocText {
  opener: string;
  situation: [string, string];
  ask: string;
  closing: string;
  idLabel: string;
}

export interface DocTypeDef {
  key: string;
  style: "letter" | "chat";
  task: string;
  taskKind: BenchTaskKind;
  org: OrgSource;
  /** Gold roles (always English, like `synth.v1`'s output). */
  otherRole: string;
  orgRole: string;
  /** ID format: `#` → digit. */
  idFormat: string;
  /** Extra slot sentences, in order: medium uses the first two, long uses all. */
  extras: ExtraSlot[];
  /** Situation sentences that need a third person (group chat) or a child (school email). */
  needsOther2?: boolean;
  needsChild?: boolean;
  text: Record<Language, DocText>;
}

export const DOC_TYPES: DocTypeDef[] = [
  {
    key: "text-message thread", style: "chat", task: "Draft a reply to my friend about what to tell my employer.", taskKind: "reply", org: "employer",
    otherRole: "the writer's friend", orgRole: "the writer's employer", idFormat: "CASE-#####", extras: ["contact", "id", "dob", "otp", "iban"],
    text: {
      en: { opener: "{other_first}: hey, you around?", situation: ["{other_first}: did you hear back from {org} about the shifts?", "{writer_first}: not yet, they keep moving my rota around"], ask: "{other_first}: you should tell them straight. want me to help write it?", closing: "{writer_first}: thanks, talk later", idLabel: "case number" },
      es: { opener: "{other_first}: ey, ¿estás?", situation: ["{other_first}: ¿te ha dicho algo {org} de los turnos?", "{writer_first}: todavía no, me siguen cambiando el cuadrante"], ask: "{other_first}: díselo claro. ¿te ayudo a escribirlo?", closing: "{writer_first}: gracias, luego hablamos", idLabel: "número de expediente" },
      de: { opener: "{other_first}: hey, bist du da?", situation: ["{other_first}: hat sich {org} wegen der Schichten gemeldet?", "{writer_first}: noch nicht, die schieben meinen Dienstplan dauernd um"], ask: "{other_first}: sag es ihnen direkt. soll ich dir beim Schreiben helfen?", closing: "{writer_first}: danke, bis später", idLabel: "Vorgangsnummer" },
    },
  },
  {
    key: "email to HR", style: "letter", task: "Help me write a firm but polite email to HR about unpaid overtime.", taskKind: "reply", org: "employer",
    otherRole: "the writer's HR manager", orgRole: "the writer's employer", idFormat: "EMP-#####", extras: ["id", "contact", "dob", "third", "iban"],
    text: {
      en: { opener: "Dear {other},", situation: ["I am writing about my overtime from the last two months, which has not been paid.", "I have worked at {org} for six years and my manager agreed to the extra shifts, but the payslips do not show them."], ask: "Could you tell me how this will be corrected and when?", closing: "Kind regards,\n{writer}", idLabel: "employee number" },
      es: { opener: "Buenos días, {other}:", situation: ["Les escribo por las horas extra de los dos últimos meses, que no me han pagado.", "Llevo seis años en {org} y mi responsable aprobó los turnos extra, pero no aparecen en las nóminas."], ask: "¿Podrían decirme cómo y cuándo se va a corregir?", closing: "Un saludo,\n{writer}", idLabel: "número de empleado" },
      de: { opener: "Guten Tag {other},", situation: ["ich schreibe wegen meiner Überstunden aus den letzten zwei Monaten, die nicht bezahlt wurden.", "Ich arbeite seit sechs Jahren bei {org}, meine Vorgesetzte hat die Zusatzschichten genehmigt, aber auf den Abrechnungen fehlen sie."], ask: "Können Sie mir sagen, wie und wann das korrigiert wird?", closing: "Viele Grüße\n{writer}", idLabel: "Personalnummer" },
    },
  },
  {
    key: "landlord dispute", style: "letter", task: "Reply firmly to my landlord about the deposit they are keeping.", taskKind: "reply", org: "landlords",
    otherRole: "the writer's landlord", orgRole: "the writer's letting agency", idFormat: "REF-####-##", extras: ["contact", "id", "iban", "third", "dob"],
    text: {
      en: { opener: "Dear {other},", situation: ["{org} is refusing to return my deposit after I moved out in September.", "You say the carpet was damaged, but it was already worn when I moved in and it is in the check-in report."], ask: "Please return the full deposit or explain each deduction in writing.", closing: "Regards,\n{writer}", idLabel: "tenancy reference" },
      es: { opener: "Hola, {other}:", situation: ["{org} se niega a devolverme la fianza desde que me fui en septiembre.", "Dice que la moqueta estaba dañada, pero ya estaba gastada cuando entré y así consta en el inventario."], ask: "Le pido que me devuelva la fianza completa o que justifique cada descuento por escrito.", closing: "Un saludo,\n{writer}", idLabel: "número de contrato" },
      de: { opener: "Hallo {other},", situation: ["{org} weigert sich, mir die Kaution zurückzuzahlen, seit ich im September ausgezogen bin.", "Sie sagen, der Teppich sei beschädigt, aber er war schon beim Einzug abgenutzt und das steht im Übergabeprotokoll."], ask: "Bitte zahlen Sie die volle Kaution zurück oder begründen Sie jeden Abzug schriftlich.", closing: "Viele Grüße\n{writer}", idLabel: "Vertragsnummer" },
    },
  },
  {
    key: "insurance letter", style: "letter", task: "Explain what this insurance decision means for my claim.", taskKind: "explain", org: "insurers",
    otherRole: "the writer's claims handler", orgRole: "the writer's insurer", idFormat: "CLM-######", extras: ["id", "contact", "health", "dob", "iban"],
    text: {
      en: { opener: "Dear {other},", situation: ["I received your letter about my claim after the water leak in my kitchen.", "{org} says the damage is not covered because it happened gradually, which I do not understand."], ask: "Please explain which part of my policy this decision is based on.", closing: "Yours sincerely,\n{writer}", idLabel: "claim number" },
      es: { opener: "Buenos días, {other}:", situation: ["He recibido su carta sobre mi siniestro por la fuga de agua en la cocina.", "{org} dice que los daños no están cubiertos porque se produjeron poco a poco, y no lo entiendo."], ask: "Les ruego que me indiquen en qué parte de la póliza se basa esta decisión.", closing: "Atentamente,\n{writer}", idLabel: "número de siniestro" },
      de: { opener: "Guten Tag {other},", situation: ["ich habe Ihr Schreiben zu meinem Schaden nach dem Wasserrohrbruch in der Küche erhalten.", "{org} schreibt, der Schaden sei nicht versichert, weil er allmählich entstanden sei, und das verstehe ich nicht."], ask: "Bitte erklären Sie mir, auf welche Stelle meiner Police sich diese Entscheidung stützt.", closing: "Mit freundlichen Grüßen\n{writer}", idLabel: "Schadennummer" },
    },
  },
  {
    key: "job offer", style: "letter", task: "What questions should I ask before accepting this job offer?", taskKind: "questions", org: "recruiters",
    otherRole: "the writer's recruiter", orgRole: "the writer's recruitment agency", idFormat: "REF-####-##", extras: ["contact", "id", "dob", "third", "iban"],
    text: {
      en: { opener: "Hi {other},", situation: ["Thank you for sending the offer through {org} yesterday.", "The salary is lower than we discussed and the contract mentions a six-month probation period."], ask: "Before I decide, can we talk about the start date and the probation terms?", closing: "Best,\n{writer}", idLabel: "offer reference" },
      es: { opener: "Hola, {other}:", situation: ["Gracias por enviarme ayer la oferta a través de {org}.", "El sueldo es más bajo de lo que hablamos y el contrato menciona un periodo de prueba de seis meses."], ask: "Antes de decidir, ¿podemos hablar de la fecha de incorporación y del periodo de prueba?", closing: "Un saludo,\n{writer}", idLabel: "número de referencia" },
      de: { opener: "Hallo {other},", situation: ["danke, dass Sie mir gestern das Angebot über {org} geschickt haben.", "Das Gehalt ist niedriger als besprochen und im Vertrag steht eine Probezeit von sechs Monaten."], ask: "Bevor ich mich entscheide: Können wir über den Starttermin und die Probezeit sprechen?", closing: "Beste Grüße\n{writer}", idLabel: "Referenznummer" },
    },
  },
  {
    key: "medical bill", style: "letter", task: "Explain this medical bill and what I am being charged for.", taskKind: "explain", org: "clinics",
    otherRole: "the writer's billing contact", orgRole: "the writer's clinic", idFormat: "INV-######", extras: ["id", "health", "contact", "dob", "iban"],
    text: {
      en: { opener: "Dear {other},", situation: ["I was seen at {org} in October and I have now received a bill I cannot follow.", "There are three charges for the same day and one of them is listed as a specialist visit I do not remember."], ask: "Could you send me an itemised breakdown of what each charge is for?", closing: "Thank you,\n{writer}", idLabel: "invoice number" },
      es: { opener: "Buenos días, {other}:", situation: ["Me atendieron en {org} en octubre y ahora me ha llegado una factura que no entiendo.", "Hay tres cargos del mismo día y uno aparece como consulta con especialista que no recuerdo."], ask: "¿Podrían enviarme un desglose de cada cargo?", closing: "Gracias,\n{writer}", idLabel: "número de factura" },
      de: { opener: "Guten Tag {other},", situation: ["ich war im Oktober im {org} und habe jetzt eine Rechnung bekommen, die ich nicht nachvollziehen kann.", "Es gibt drei Posten vom selben Tag und einer ist als Facharztbesuch aufgeführt, an den ich mich nicht erinnere."], ask: "Könnten Sie mir eine Aufstellung schicken, wofür die einzelnen Posten sind?", closing: "Danke und viele Grüße\n{writer}", idLabel: "Rechnungsnummer" },
    },
  },
  {
    key: "school email", style: "letter", task: "Summarise this school email and tell me what I need to do.", taskKind: "summary", org: "schools", needsChild: true,
    otherRole: "the writer's child's teacher", orgRole: "the writer's child's school", idFormat: "STU-#####", extras: ["contact", "id", "health", "dob", "third"],
    text: {
      en: { opener: "Dear {other},", situation: ["My child {child} came home upset again about the group project.", "I would like to understand what support {org} can offer before the exams in spring."], ask: "Could we meet next week to talk about it?", closing: "Many thanks,\n{writer}", idLabel: "student number" },
      es: { opener: "Hola, {other}:", situation: ["Mi hijo {child} volvió a casa disgustado otra vez por el trabajo en grupo.", "Me gustaría saber qué apoyo puede ofrecer {org} antes de los exámenes de primavera."], ask: "¿Podríamos vernos la semana que viene para hablarlo?", closing: "Muchas gracias,\n{writer}", idLabel: "número de expediente" },
      de: { opener: "Hallo {other},", situation: ["mein Kind {child} kam schon wieder traurig wegen der Gruppenarbeit nach Hause.", "Ich würde gern verstehen, welche Unterstützung die {org} vor den Prüfungen im Frühjahr anbieten kann."], ask: "Könnten wir uns nächste Woche dazu treffen?", closing: "Vielen Dank\n{writer}", idLabel: "Schülernummer" },
    },
  },
  {
    key: "contract clause", style: "letter", task: "Explain this contract clause in plain words.", taskKind: "explain", org: "employer",
    otherRole: "the writer's manager", orgRole: "the writer's employer", idFormat: "CTR-####-###", extras: ["id", "contact", "third", "dob", "iban"],
    text: {
      en: { opener: "Hi {other},", situation: ["Clause 7.2 of my contract with {org} says I cannot work for a competitor within 50 miles for two years.", "You told me it is standard, but it seems very broad for my role."], ask: "Can you tell me how the company actually applies this clause?", closing: "Thanks,\n{writer}", idLabel: "contract number" },
      es: { opener: "Hola, {other}:", situation: ["La cláusula 7.2 de mi contrato con {org} dice que no puedo trabajar para la competencia a menos de 80 km durante dos años.", "Me dijiste que es lo habitual, pero me parece muy amplia para mi puesto."], ask: "¿Me puedes explicar cómo aplica la empresa esta cláusula en la práctica?", closing: "Gracias,\n{writer}", idLabel: "número de contrato" },
      de: { opener: "Hallo {other},", situation: ["Klausel 7.2 meines Vertrags mit {org} besagt, dass ich zwei Jahre lang im Umkreis von 80 km nicht für die Konkurrenz arbeiten darf.", "Du hast gesagt, das sei üblich, aber für meine Stelle wirkt es sehr weit gefasst."], ask: "Kannst du mir sagen, wie die Firma diese Klausel tatsächlich anwendet?", closing: "Danke\n{writer}", idLabel: "Vertragsnummer" },
    },
  },
  {
    key: "scam message", style: "letter", task: "Is this message a scam, and what should I do now?", taskKind: "help", org: "banks",
    otherRole: "a person claiming to be from the writer's bank", orgRole: "the writer's bank", idFormat: "ACC-########", extras: ["otp", "id", "password", "contact", "iban"],
    text: {
      en: { opener: "I need help with a message I got this morning.", situation: ["Someone called {other} texted me saying they work for {org} and that my account has been frozen.", "They said I had to confirm my details today or lose access to my savings."], ask: "Is this a scam, and what should I do now?", closing: "Thanks,\n{writer}", idLabel: "account number" },
      es: { opener: "Necesito ayuda con un mensaje que me llegó esta mañana.", situation: ["Una persona llamada {other} me escribió diciendo que trabaja en {org} y que mi cuenta está bloqueada.", "Me dijo que tenía que confirmar mis datos hoy o perdería el acceso a mis ahorros."], ask: "¿Es una estafa? ¿Qué hago ahora?", closing: "Gracias,\n{writer}", idLabel: "número de cuenta" },
      de: { opener: "Ich brauche Hilfe mit einer Nachricht von heute Morgen.", situation: ["Jemand namens {other} hat mir geschrieben, er arbeite für die {org} und mein Konto sei gesperrt.", "Ich müsse heute meine Daten bestätigen, sonst verliere ich den Zugriff auf mein Erspartes."], ask: "Ist das Betrug, und was soll ich jetzt tun?", closing: "Danke\n{writer}", idLabel: "Kontonummer" },
    },
  },
  {
    key: "group chat", style: "chat", task: "Summarise this group chat and list what we need to do.", taskKind: "summary", org: "schools", needsOther2: true,
    otherRole: "a parent in the writer's group chat", orgRole: "the writer's child's school", idFormat: "BK-######", extras: ["third", "id", "contact", "dob", "health"],
    text: {
      en: { opener: "{other2_first}: morning all", situation: ["{other_first}: has anyone heard from {org} about the trip?", "{other2_first}: they want the forms and the money back by Friday"], ask: "{other_first}: {writer_first} can you sum up what we need to do?", closing: "{writer_first}: will do", idLabel: "booking reference" },
      es: { opener: "{other2_first}: buenos días a todos", situation: ["{other_first}: ¿alguien sabe algo de {org} sobre la excursión?", "{other2_first}: quieren las autorizaciones y el dinero antes del viernes"], ask: "{other_first}: {writer_first}, ¿puedes resumir lo que hay que hacer?", closing: "{writer_first}: hecho", idLabel: "número de reserva" },
      de: { opener: "{other2_first}: morgen zusammen", situation: ["{other_first}: hat jemand was von der {org} wegen dem Ausflug gehört?", "{other2_first}: die wollen die Zettel und das Geld bis Freitag zurück"], ask: "{other_first}: {writer_first}, kannst du kurz zusammenfassen, was wir machen müssen?", closing: "{writer_first}: mach ich", idLabel: "Buchungsnummer" },
    },
  },
];

export interface SlotSentences {
  intro: string;
  introWithOccupation: string;
  address: string;
  contact: string;
  id: string;
  dob: string;
  otp: string;
  password: string;
  health: string;
  iban: string;
  third: string;
  quasi: string;
}

export const LETTER_SLOTS: Record<Language, SlotSentences> = {
  en: {
    intro: "My name is {writer} and I work at {employer} in {city}.", introWithOccupation: "My name is {writer} and I work as a {occupation} at {employer} in {city}.",
    address: "I live at {address}.", contact: "You can reach me on {phone} or at {email}.", id: "The {id_label} is {id}.", dob: "For your records, I was born on {dob}.",
    otp: "Later someone asked me for the code {otp} that was sent to my phone.", password: "I also wrote down my online banking password: {password}",
    health: "I am currently being treated for {health}.", iban: "Any refund can go to my account {iban}.", third: "My colleague {other2} had the same problem last year.",
    quasi: "{lead}{quasi}.",
  },
  es: {
    intro: "Me llamo {writer} y trabajo en {employer}, en {city}.", introWithOccupation: "Me llamo {writer} y trabajo como {occupation} en {employer}, en {city}.",
    address: "Vivo en {address}.", contact: "Pueden localizarme en el {phone} o en {email}.", id: "El {id_label} es {id}.", dob: "Para que conste, nací el {dob}.",
    otp: "Después alguien me pidió el código {otp} que me llegó al móvil.", password: "También apunté mi contraseña de la banca online: {password}",
    health: "Ahora mismo estoy en tratamiento por {health}.", iban: "Cualquier devolución puede ir a mi cuenta {iban}.", third: "Mi compañero {other2} tuvo el mismo problema el año pasado.",
    quasi: "{lead}{quasi}.",
  },
  de: {
    intro: "Mein Name ist {writer}, ich arbeite bei {employer} in {city}.", introWithOccupation: "Mein Name ist {writer}, ich arbeite als {occupation} bei {employer} in {city}.",
    address: "Meine Adresse: {address}.", contact: "Sie erreichen mich unter {phone} oder per E-Mail an {email}.", id: "Die {id_label} lautet {id}.", dob: "Der Vollständigkeit halber: Ich bin am {dob} geboren.",
    otp: "Später hat mich jemand nach dem Code {otp} gefragt, der auf mein Handy kam.", password: "Ich habe mir auch mein Online-Banking-Passwort notiert: {password}",
    health: "Ich bin zurzeit wegen {health} in Behandlung.", iban: "Eine Erstattung kann auf mein Konto {iban} gehen.", third: "Mein Kollege {other2} hatte letztes Jahr dasselbe Problem.",
    quasi: "{lead}{quasi}.",
  },
};

export const CHAT_SLOTS: Record<Language, SlotSentences> = {
  en: {
    intro: "{writer_first}: it's {writer} btw, new phone. still at {employer} in {city}", introWithOccupation: "{writer_first}: it's {writer} btw, new phone. still working as a {occupation} at {employer} in {city}",
    address: "{writer_first}: come round to {address} after 6", contact: "{writer_first}: new number is {phone}, email {email}", id: "{writer_first}: the {id_label} they gave me is {id}",
    dob: "{other_first}: isn't your birthday coming up?\n{writer_first}: born {dob}, don't remind me", otp: "{writer_first}: someone texted me a code {otp} and asked me to send it back??",
    password: "{writer_first}: note to self, password: {password}", health: "{writer_first}: doctor says it's {health}", iban: "{writer_first}: send it to {iban} when you can",
    third: "{other2_first}: hi all, {other_first} added me", quasi: "{writer_first}: {quasi} lol",
  },
  es: {
    intro: "{writer_first}: soy {writer}, móvil nuevo. sigo en {employer}, en {city}", introWithOccupation: "{writer_first}: soy {writer}, móvil nuevo. sigo de {occupation} en {employer}, en {city}",
    address: "{writer_first}: pasaos por {address} después de las 6", contact: "{writer_first}: mi número nuevo es {phone}, el correo {email}", id: "{writer_first}: el {id_label} que me dieron es {id}",
    dob: "{other_first}: ¿no es pronto tu cumple?\n{writer_first}: nací el {dob}, no me lo recuerdes", otp: "{writer_first}: alguien me mandó un código {otp} y me pidió que se lo reenviara??",
    password: "{writer_first}: para que no se me olvide, contraseña: {password}", health: "{writer_first}: el médico dice que es {health}", iban: "{writer_first}: mándalo a {iban} cuando puedas",
    third: "{other2_first}: hola a todos, me ha añadido {other_first}", quasi: "{writer_first}: {quasi} jaja",
  },
  de: {
    intro: "{writer_first}: ich bin's, {writer}, neues Handy. immer noch bei {employer} in {city}", introWithOccupation: "{writer_first}: ich bin's, {writer}, neues Handy. immer noch als {occupation} bei {employer} in {city}",
    address: "{writer_first}: kommt nach 6 vorbei: {address}", contact: "{writer_first}: neue Nummer ist {phone}, Mail {email}", id: "{writer_first}: die {id_label}, die sie mir gegeben haben, ist {id}",
    dob: "{other_first}: hast du nicht bald Geburtstag?\n{writer_first}: geboren am {dob}, erinner mich nicht dran", otp: "{writer_first}: jemand hat mir einen Code {otp} geschickt und will, dass ich ihn zurückschicke??",
    password: "{writer_first}: notiz an mich, Passwort: {password}", health: "{writer_first}: der Arzt sagt, es ist {health}", iban: "{writer_first}: überweis es einfach auf {iban}",
    third: "{other2_first}: hallo zusammen, {other_first} hat mich hinzugefügt", quasi: "{writer_first}: {quasi} haha",
  },
};

/** Organisation list for a doc type. */
export const orgList = (p: LanguageParts, src: OrgSource): string[] => (src === "employer" ? p.employers : p[src]);
