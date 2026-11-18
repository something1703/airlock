// Fictional building blocks for the template generator (`synth-tpl.v1`). Every person, place, organisation
// and number is invented and assembled from parts at generation time. Rules:
// - no provider-format secrets (API keys, tokens): the repo's secret scanner must never fire (scripts/lint.sh);
// - emails use the reserved example.com / example.org / example.net domains;
// - card numbers use the 4000 00 test prefix; phone numbers use drama/test ranges where a country has one.
import type { Language } from "../dataset";

export interface Place {
  name: string;
  metro: string;
}

export interface QuasiDef {
  text: string;
  reveals: "occupation" | "location" | "event" | "relationship" | "employer";
  /** For occupation quasi in the hard set: the profile occupation it reveals. */
  occupation?: string;
}

export interface LanguageParts {
  first: string[];
  last: string[];
  cities: Place[];
  smallTowns: Place[];
  streets: string[];
  /** `{n}` number, `{s}` street name, `{u}` unit. */
  addressFormats: string[];
  employers: string[];
  landlords: string[];
  insurers: string[];
  clinics: string[];
  schools: string[];
  banks: string[];
  recruiters: string[];
  occupations: string[];
  rareOccupations: QuasiDef[];
  quasi: QuasiDef[];
  health: string[];
  months: string[];
  /** `{d}` day, `{m}` month name, `{y}` year. */
  dobFormat: string;
  /** `{a}`/`{b}`/`{c}` digit groups. */
  phoneFormats: string[];
  ibanCountry: string;
  ibanBankDigits: number;
  ibanAccountDigits: number;
  passwordWords: string[];
  fillers: string[];
  chatFillers: string[];
  quasiLead: string[];
}

export const PARTS: Record<Language, LanguageParts> = {
  en: {
    first: ["Maya", "Daniel", "Priya", "Owen", "Grace", "Tomas", "Leila", "Marcus", "Hannah", "Felix", "Imogen", "Rafael", "Nadia", "Elliot", "Sophie", "Jonah", "Aisha", "Callum", "Zara", "Theo"],
    last: ["Hartwell", "Okafor", "Lindqvist", "Brennan", "Achterberg", "Mallory", "Quayle", "Thornbury", "Ashdown", "Pemberton", "Rourke", "Castellan", "Whitlock", "Fairbairn", "Okonjo", "Delacroix", "Varga", "Marchetti", "Holloway", "Sandoval"],
    cities: [
      { name: "Harlow Bay", metro: "Harlow" }, { name: "North Harlow", metro: "Harlow" }, { name: "Millbrook", metro: "Millbrook" },
      { name: "Ashcombe", metro: "Ashcombe" }, { name: "East Fenwick", metro: "Fenwick" }, { name: "Fenwick", metro: "Fenwick" },
      { name: "Corrin Falls", metro: "Corrin Falls" }, { name: "Wexley", metro: "Wexley" },
    ],
    smallTowns: [{ name: "Little Tarrow", metro: "Little Tarrow" }, { name: "Pennock Cross", metro: "Pennock Cross" }, { name: "Gillamoor Edge", metro: "Gillamoor Edge" }, { name: "Saltwick Ford", metro: "Saltwick Ford" }],
    streets: ["Juniper", "Calloway", "Birchwood", "Marlow", "Ferris", "Stanwick", "Halden", "Larkspur"],
    addressFormats: ["{n} {s} Road", "{n} {s} Lane", "{n} {s} Avenue", "{n} {s} Street, Apt {u}", "Flat {u}, {n} {s} Close"],
    employers: ["Brightwater Logistics", "Mercy Vale Hospital", "Northgate Primary School", "Halden Freight Services", "Redfern Dental Clinic", "Ashcombe Community College", "Tarrow Valley Water Board", "Kestrel Print Works"],
    landlords: ["Harbourside Lettings", "Calloway Property Group", "Fenwick Homes Ltd"],
    insurers: ["Calloway & Finch Insurance", "Bluestone Mutual", "Harlow Shield Assurance"],
    clinics: ["Millbrook Medical Centre", "St Brannoc's Hospital", "Wexley Family Clinic"],
    schools: ["Northgate Primary School", "Ashcombe Park Academy", "Corrin Falls High School"],
    banks: ["Fenwick Building Society", "Harlow Savings Bank", "Larkspur Bank"],
    recruiters: ["Kestrel Talent Partners", "Marlow & Pike Recruitment", "Stanwick Careers"],
    occupations: ["nurse", "warehouse supervisor", "primary school teacher", "bus driver", "accountant", "dental hygienist", "software tester", "care worker"],
    rareOccupations: [
      { text: "I am the only harbour pilot in town", reveals: "occupation", occupation: "harbour pilot" },
      { text: "I restore church organs for a living", reveals: "occupation", occupation: "church organ restorer" },
      { text: "I teach the only Icelandic class in the county", reveals: "occupation", occupation: "Icelandic teacher" },
      { text: "I run the falconry display at the castle every weekend", reveals: "occupation", occupation: "falconer" },
    ],
    quasi: [
      { text: "I won the regional sheepdog trials last spring", reveals: "event" },
      { text: "our house is the one next to the old lighthouse", reveals: "location" },
      { text: "my twin brother is the town mayor", reveals: "relationship" },
      { text: "I was the first woman to captain the lifeboat crew here", reveals: "event" },
      { text: "I work night shifts on the children's ward", reveals: "employer" },
      { text: "I coach the under-12 rowing team on Saturdays", reveals: "event" },
    ],
    health: ["type 2 diabetes", "asthma", "a torn knee ligament", "migraines"],
    months: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
    dobFormat: "{d} {m} {y}",
    phoneFormats: ["07700 900{a}", "312-555-01{b}", "+44 7700 900{a}"],
    ibanCountry: "GB",
    ibanBankDigits: 0,
    ibanAccountDigits: 14,
    passwordWords: ["Tulip", "Rain", "Copper", "Lantern", "Maple", "Otter"],
    fillers: [
      "This has been going on for a while now.", "I have kept copies of everything.", "I would really appreciate a clear answer.",
      "Nobody has explained what happens next.", "I am not sure whether this is normal.", "I tried calling twice but nobody picked up.",
      "It is starting to affect my sleep.", "I do not want to make this bigger than it is.", "A friend said I should put it in writing.",
      "I can send photos if that helps.", "I am free most afternoons after three.", "Please let me know if anything is missing.",
      "I have read the letter three times and I still do not understand it.", "The deadline they gave is very short.", "I would rather sort this out without a fight.",
      "Thank you for taking the time to read this.", "I am happy to come in person.", "I want to be sure I am not missing anything important.",
    ],
    chatFillers: ["ok", "haha yes", "no worries", "wait really?", "omg", "sounds good", "brb", "same tbh", "ugh", "fair enough"],
    quasiLead: ["By the way, ", "Not that it matters, but ", "For context, "],
  },
  es: {
    first: ["Lucía", "Mateo", "Carmen", "Javier", "Elena", "Diego", "Pilar", "Andrés", "Rocío", "Iñigo", "Marta", "Álvaro", "Nuria", "Sergio", "Inés", "Gonzalo"],
    last: ["Ferrández", "Arrieta", "Montalbán", "Escudero", "Villaseñor", "Quintanilla", "Barrachina", "Ocaña", "Lizarraga", "Benavente", "Cuadrado", "Peñalver"],
    cities: [
      { name: "Villanueva del Arce", metro: "Arce" }, { name: "San Telmo de Arce", metro: "Arce" }, { name: "Puerto Almira", metro: "Almira" },
      { name: "Robledo de la Sierra", metro: "Robledo" }, { name: "Castrejón", metro: "Castrejón" }, { name: "Monteluz", metro: "Monteluz" },
    ],
    smallTowns: [{ name: "Aldealuz de Abajo", metro: "Aldealuz de Abajo" }, { name: "Fuentehonda", metro: "Fuentehonda" }, { name: "Valdepiedra", metro: "Valdepiedra" }, { name: "Olmedilla del Río", metro: "Olmedilla del Río" }],
    streets: ["los Almendros", "Arcipreste Vidal", "la Fragua", "San Ciriaco", "las Moreras", "Doctor Lledó"],
    addressFormats: ["Calle {s} {n}", "Avenida de {s} {n}, piso {u}", "Plaza de {s} {n}", "Calle {s} {n}, puerta {u}"],
    employers: ["Transportes Olivar", "Clínica Santa Brígida", "Colegio Los Almendros", "Conservas Marisol", "Talleres Arrieta Hermanos", "Hotel Mirador de Almira", "Cooperativa Agrícola del Arce"],
    landlords: ["Inmobiliaria Montesol", "Gestión de Alquileres Arce", "Fincas Benavente"],
    insurers: ["Seguros Peñalta", "Mutua del Levante Sur", "Aseguradora Almira"],
    clinics: ["Centro de Salud Monteluz", "Hospital Comarcal del Arce", "Clínica Santa Brígida"],
    schools: ["Colegio Los Almendros", "Instituto Robledo", "Colegio San Ciriaco"],
    banks: ["Caja Rural del Arce", "Banco Almira", "Caja Monteluz"],
    recruiters: ["Talento Levante", "Selección Ocaña y Asociados", "Empleo Almira"],
    occupations: ["auxiliar de enfermería", "contable", "docente de primaria", "recepcionista", "electricista", "agente de seguros", "conductor de reparto"],
    rareOccupations: [
      { text: "soy el único práctico del puerto del pueblo", reveals: "occupation", occupation: "práctico del puerto" },
      { text: "me dedico a restaurar órganos de iglesia", reveals: "occupation", occupation: "restaurador de órganos" },
      { text: "doy la única clase de islandés de la comarca", reveals: "occupation", occupation: "profesor de islandés" },
      { text: "llevo la exhibición de cetrería del castillo los fines de semana", reveals: "occupation", occupation: "cetrero" },
    ],
    quasi: [
      { text: "gané el concurso comarcal de tortilla el año pasado", reveals: "event" },
      { text: "vivimos justo al lado del antiguo faro", reveals: "location" },
      { text: "mi hermana gemela es la alcaldesa", reveals: "relationship" },
      { text: "fui la primera mujer en dirigir la banda municipal", reveals: "event" },
      { text: "hago el turno de noche en la planta de pediatría", reveals: "employer" },
      { text: "entreno al equipo infantil de remo los sábados", reveals: "event" },
    ],
    health: ["diabetes tipo 2", "asma", "una rotura de ligamento", "migrañas"],
    months: ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
    dobFormat: "{d} de {m} de {y}",
    phoneFormats: ["+34 600 000 {a}", "600 000 {a}", "+34 699 00 0{b}"],
    ibanCountry: "ES",
    ibanBankDigits: 8,
    ibanAccountDigits: 12,
    passwordWords: ["Tulipan", "Lluvia", "Cobre", "Farol", "Arce", "Nutria"],
    fillers: [
      "Esto viene pasando desde hace tiempo.", "He guardado copia de todo.", "Agradecería mucho una respuesta clara.",
      "Nadie me ha explicado qué pasa ahora.", "No sé si esto es normal.", "Llamé dos veces pero nadie contestó.",
      "Me está quitando el sueño.", "No quiero hacer de esto algo más grande.", "Una amiga me dijo que lo pusiera por escrito.",
      "Puedo mandar fotos si ayuda.", "Estoy libre casi todas las tardes a partir de las tres.", "Avísenme si falta algo.",
      "He leído la carta tres veces y sigo sin entenderla.", "El plazo que me dan es muy corto.", "Preferiría arreglarlo sin discutir.",
      "Gracias por tomarse el tiempo de leer esto.", "Puedo ir en persona si hace falta.", "Quiero asegurarme de no pasar nada por alto.",
    ],
    chatFillers: ["vale", "jaja sí", "tranqui", "¿en serio?", "madre mía", "genial", "ahora vuelvo", "yo igual", "uf", "bueno"],
    quasiLead: ["Por cierto, ", "No sé si importa, pero ", "Para que tengáis contexto, "],
  },
  de: {
    first: ["Jonas", "Lena", "Matthias", "Katrin", "Florian", "Anja", "Tobias", "Miriam", "Lukas", "Svenja", "Henrik", "Johanna", "Benedikt", "Theresa"],
    last: ["Kesselring", "Brandauer", "Wittkamp", "Oberländer", "Reinholz", "Habermehl", "Ellerbrock", "Vogelsang", "Rautenberg", "Kühnhold", "Pfefferkorn", "Dünnwald"],
    cities: [
      { name: "Neustadt am Kessel", metro: "Kessel" }, { name: "Kesselbrück", metro: "Kessel" }, { name: "Birkenfelde", metro: "Birkenfelde" },
      { name: "Lindwerder", metro: "Lindwerder" }, { name: "Hohenmoor", metro: "Hohenmoor" }, { name: "Altenrode", metro: "Altenrode" },
    ],
    smallTowns: [{ name: "Kleinwiesental", metro: "Kleinwiesental" }, { name: "Ottersberg-Moor", metro: "Ottersberg-Moor" }, { name: "Haselbach im Grund", metro: "Haselbach im Grund" }, { name: "Wendhusen", metro: "Wendhusen" }],
    streets: ["Lindenhof", "Amselgrund", "Kesselgarten", "Mühlbach", "Birkenhain", "Eulenweg"],
    addressFormats: ["{s}straße {n}", "{s}weg {n}", "Am {s} {n}", "{s}straße {n}, Wohnung {u}"],
    employers: ["Kesselbach Maschinenbau GmbH", "Klinikum Birkenfelde", "Grundschule am Amselgrund", "Bäckerei Habermehl", "Stadtwerke Hohenmoor", "Spedition Ellerbrock", "Altenroder Druckhaus"],
    landlords: ["Wohnbau Lindwerder GmbH", "Hausverwaltung Rautenberg", "Kessel Immobilien"],
    insurers: ["Lindwerder Versicherung AG", "Hohenmoorer Assekuranz", "Birkenfelder Hausrat"],
    clinics: ["Klinikum Birkenfelde", "Gesundheitszentrum Mühlbach", "Kreiskrankenhaus Altenrode"],
    schools: ["Grundschule am Amselgrund", "Realschule Kesselbrück", "Gesamtschule Hohenmoor"],
    banks: ["Sparkasse Kesselbrück", "Volksbank Altenrode", "Lindwerder Bank"],
    recruiters: ["Kessel Personal GmbH", "Talentwerk Birkenfelde", "Jobhaus Lindwerder"],
    occupations: ["Pflegekraft", "Lehrkraft", "Fachkraft für Lagerlogistik", "Bürokraft", "Verwaltungsfachkraft", "Küchenhilfe", "Reinigungskraft"],
    rareOccupations: [
      { text: "ich arbeite als Hafenlotse, als einziger im Ort", reveals: "occupation", occupation: "Hafenlotse" },
      { text: "ich restauriere beruflich Kirchenorgeln", reveals: "occupation", occupation: "Orgelrestaurator" },
      { text: "ich gebe den einzigen Isländischkurs im Landkreis", reveals: "occupation", occupation: "Isländischlehrer" },
      { text: "ich leite am Wochenende die Falknerei-Vorführung auf der Burg", reveals: "occupation", occupation: "Falkner" },
    ],
    quasi: [
      { text: "ich habe letztes Jahr die Kreismeisterschaft im Hufeisenwerfen gewonnen", reveals: "event" },
      { text: "unser Haus steht direkt neben dem alten Leuchtturm", reveals: "location" },
      { text: "meine Zwillingsschwester ist die Bürgermeisterin", reveals: "relationship" },
      { text: "ich war die erste Frau an der Spitze der freiwilligen Feuerwehr hier", reveals: "event" },
      { text: "ich arbeite im Nachtdienst auf der Kinderstation", reveals: "employer" },
      { text: "ich trainiere samstags die Ruder-Jugendmannschaft", reveals: "event" },
    ],
    health: ["Diabetes Typ 2", "Asthma", "Migräne", "Bluthochdruck"],
    months: ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"],
    dobFormat: "{d}. {m} {y}",
    phoneFormats: ["+49 151 0000 {c}", "0151 0000 {c}", "+49 30 0000 {c}"],
    ibanCountry: "DE",
    ibanBankDigits: 8,
    ibanAccountDigits: 10,
    passwordWords: ["Tulpe", "Regen", "Kupfer", "Laterne", "Ahorn", "Otter"],
    fillers: [
      "Das geht jetzt schon eine ganze Weile so.", "Ich habe von allem Kopien aufbewahrt.", "Ich wäre für eine klare Antwort sehr dankbar.",
      "Niemand hat mir erklärt, wie es jetzt weitergeht.", "Ich weiß nicht, ob das normal ist.", "Ich habe zweimal angerufen, aber niemand ist rangegangen.",
      "Das raubt mir langsam den Schlaf.", "Ich möchte das nicht größer machen, als es ist.", "Eine Freundin meinte, ich solle es schriftlich machen.",
      "Ich kann gern Fotos schicken.", "Nachmittags ab drei habe ich meistens Zeit.", "Bitte sagen Sie mir, falls etwas fehlt.",
      "Ich habe den Brief dreimal gelesen und verstehe ihn immer noch nicht.", "Die Frist ist sehr kurz.", "Ich würde das lieber ohne Streit klären.",
      "Danke, dass Sie sich die Zeit nehmen.", "Ich kann auch persönlich vorbeikommen.", "Ich möchte sicher sein, dass ich nichts Wichtiges übersehe.",
    ],
    chatFillers: ["ok", "haha ja", "kein Ding", "echt jetzt?", "oh mann", "klingt gut", "bin gleich zurück", "geht mir genauso", "boah", "na gut"],
    quasiLead: ["Übrigens: ", "Nur am Rande: ", "Zur Einordnung: "],
  },
};
