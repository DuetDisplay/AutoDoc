/** Narrow, whole-question library intents. Extra topic/time qualifiers must not
 * silently become a count of the whole library. Content counts belong to retrieval.
 * These are conservative native-language aliases, not a general translator. */
export function nativeInventoryIntent(question: string): 'count' | 'list' | null {
  const text = question
    .trim()
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^[¿¡]+/gu, '')
    .replace(/[?!？。.!;]+$/gu, '')
    .trim()
  const count = [
    /^(?:combien (?:de |d’|d')?(?:réunions enregistrées|enregistrements)(?: ai[- ]je| j'ai| j’ai)?|quel est le nombre (?:de mes |d’|d')enregistrements)$/u,
    /^(?:私の)?(?:録音した会議|録音|録画|保存した会議)(?:は|が)?(?:全部で|合計)?(?:いくつ|何件|何個)(?:ありますか|ですか)?$/u,
    /^(?:how many recordings do i have|how many recorded meetings do i have|count my recordings|do i have (?:any )?(?:recordings|recorded meetings))$/u,
    /^(?:wie viele (?:aufnahmen|aufgezeichnete besprechungen) habe ich)$/u,
    /^(?:cuántas (?:grabaciones|reuniones grabadas) tengo)$/u,
    /^(?:quante (?:registrazioni|riunioni registrate) ho)$/u,
    /^(?:quantas (?:gravações|reuniões gravadas) (?:tenho|eu tenho))$/u,
    /^(?:сколько у меня (?:записей|записанных встреч))$/u,
    /^(?:скільки в мене (?:записів|записаних зустрічей))$/u,
    /^(?:我有多少(?:录音|录制的会议)|我录了多少场会议)$/u,
    /^(?:녹음한 회의는 몇 개(?:인가요|입니까)|내 녹음은 몇 개(?:인가요|입니까))$/u,
    /^(?:hoeveel opnames heb ik|ile mam nagrań|kolik mám nahrávek|koľko mám nahrávok|hur många inspelningar har jag|hvor mange optagelser har jeg|kuinka monta tallennetta minulla on|hány felvételem van|câte înregistrări am|πόσες ηχογραφήσεις έχω|колко записа имам|koliko snimki imam|koliko posnetkov imam|mitu salvestist mul on|cik ierakstu man ir|kiek įrašų turiu)$/u
  ]
  const list = [
    /^(?:liste(?:z)?|affiche(?:z)?|montre(?:z)?)(?:[- ]moi)? (?:mes |les )?(?:réunions enregistrées|enregistrements)$/u,
    /^(?:私の)?(?:録音した会議|録音|保存した会議)(?:の)?(?:一覧|リスト)(?:を)?(?:見せて(?:ください)?|表示して(?:ください)?)?$/u,
    /^(?:list my (?:recordings|recorded meetings)|show my recordings)$/u,
    /^(?:zeige meine aufnahmen|lista mis grabaciones|mostra le mie registrazioni|liste minhas gravações|покажи мои записи|покажи мої записи|显示我的录音|내 녹음 목록을 보여줘)$/u,
    /^(?:toon mijn opnames|pokaż moje nagrania|ukaž moje nahrávky|ukáž moje nahrávky|visa mina inspelningar|vis mine optagelser|näytä tallenteeni|mutasd a felvételeimet|arată înregistrările mele|δείξε τις ηχογραφήσεις μου|покажи моите записи|pokaži moje snimke|pokaži moje posnetke|näita minu salvestisi|parādi manus ierakstus|parodyk mano įrašus)$/u
  ]
  return count.some((pattern) => pattern.test(text))
    ? 'count'
    : list.some((pattern) => pattern.test(text))
      ? 'list'
      : null
}

/** Unknown library qualifiers clarify rather than count a ranked subset. */
export function hasInventoryRequestCue(question: string): boolean {
  const q = question.normalize('NFKC').toLowerCase()
  return (
    /\b(?:how many|number of|count|list|show)(?: my| the| all| saved)* (?:recordings|recorded meetings)\b/iu.test(
      q
    ) ||
    /(?:combien (?:de |d’|d')?(?:réunions|enregistrements)|(?:liste|affiche|montre).*(?:réunions enregistrées|enregistrements))/iu.test(
      q
    ) ||
    /(?:録音|録画|保存した会議).*(?:いくつ|何件|何個|一覧|リスト|の数)/u.test(q) ||
    /(?:多少|数量|列表).*(?:录音|录制的会议)|(?:录音|录制的会议).*(?:多少|数量|列表)/u.test(q) ||
    /(?:wie viele aufnahmen|cuántas grabaciones|quante registrazioni|quantas gravações|сколько.*запис|скільки.*запис|hoeveel opnames|ile.*nagrań|kolik.*nahrávek|koľko.*nahrávok|hur många inspelningar|hvor mange optagelser|kuinka monta tallennetta|hány felvétel|câte înregistrări|πόσες ηχογραφήσεις|колко записа|koliko snimki|koliko posnetkov|mitu salvestist|cik ierakstu|kiek įrašų|녹음.*몇 개)/iu.test(
      q
    )
  )
}
