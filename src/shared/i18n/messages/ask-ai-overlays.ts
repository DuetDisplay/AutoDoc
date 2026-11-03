import type { UiLanguageCode } from '../../ui-language'
import type { en } from './en'

export const askAiOverlays: Record<
  Exclude<UiLanguageCode, 'en'>,
  Partial<Record<keyof typeof en, string>>
> = {
  de: {
    'askAi.indexingProgress':
      'Ihre Besprechungen werden für die KI vorbereitet ({percent} %). Sie können schon Fragen stellen, aber bis zum Abschluss fehlen in den Antworten möglicherweise einige Details.',
    'askAi.indexingPaused':
      'Die Vorbereitung Ihrer Besprechungen für die KI pausiert, während eine Aufnahme läuft oder Notizen erstellt werden ({percent} % abgeschlossen). Sie können weiterhin Fragen stellen, aber bis zum Abschluss fehlen in den Antworten möglicherweise einige Details.',

    'askAi.scope': 'Besprechungsauswahl',
    'askAi.onlyMeeting': 'Nur diese Besprechung: {title}',
    'askAi.removeScope': 'Besprechungsauswahl entfernen',
    'askAi.countReceipt': 'Gezählt: {count}. Filter: {filter}.',
    'askAi.searchAll': 'Alle Besprechungen durchsuchen',
    'askAi.askMeeting': 'Zu dieser Besprechung fragen',
    'askAi.notesPendingOne':
      'Die Notizen für {title} werden noch erstellt. Wenn Sie jetzt die KI befragen, verzögert sich die Fertigstellung der Notizen etwas.',
    'askAi.notesPendingMany':
      'Die Notizen für {count} Besprechungen werden noch erstellt. Wenn Sie jetzt die KI befragen, verzögert sich die Fertigstellung der Notizen etwas.',
    'askAi.countAll': 'alle gespeicherten Aufnahmen',
    'askAi.countAttached': 'angehängte gespeicherte Aufnahmen',
    'askAi.countNoFilters': 'keine Filter',
    'askAi.filterFrom': 'ab {value}',
    'askAi.filterThrough': 'bis einschließlich {value}',
    'askAi.filterTitle': 'Titel enthält alle Begriffe: {value}',
    'askAi.filterParticipant': 'Teilnehmer enthält alle Begriffe: {value}',
    'askAi.filterKeyword': 'Notizen oder Transkript enthalten alle Begriffe: {value}',
    'askAi.filterUnavailable': 'Filterdetails nicht verfügbar'
  },
  ja: {
    'askAi.indexingProgress':
      'AIに質問できるよう会議を準備しています（{percent}%）。今すぐ質問できますが、準備が終わるまでは回答に一部の詳細が含まれない場合があります。',
    'askAi.indexingPaused':
      '録音中またはノートの作成中のため、AIに質問するための会議の準備を一時停止しています（{percent}%完了）。引き続き質問できますが、準備が終わるまでは回答に一部の詳細が含まれない場合があります。',

    'askAi.scope': '対象の会議',
    'askAi.onlyMeeting': 'この会議のみ：{title}',
    'askAi.removeScope': '会議の指定を解除',
    'askAi.countReceipt': '件数：{count}。条件：{filter}。',
    'askAi.searchAll': 'すべての会議を検索',
    'askAi.askMeeting': 'この会議について質問',
    'askAi.notesPendingOne':
      '{title}のノートを作成中です。今AIに質問すると、完了まで少し時間がかかります。',
    'askAi.notesPendingMany':
      '{count}件の会議のノートを作成中です。今AIに質問すると、完了まで少し時間がかかります。',
    'askAi.countAll': '保存済みのすべての録音',
    'askAi.countAttached': '添付された保存済みの録音',
    'askAi.countNoFilters': '条件なし',
    'askAi.filterFrom': '{value}以降',
    'askAi.filterThrough': '{value}以前',
    'askAi.filterTitle': 'タイトルにすべての語を含む：{value}',
    'askAi.filterParticipant': '参加者名にすべての語を含む：{value}',
    'askAi.filterKeyword': 'ノートまたは文字起こしにすべての語を含む：{value}',
    'askAi.filterUnavailable': '条件の詳細を表示できません'
  },
  'zh-Hans': {
    'askAi.indexingProgress':
      '正在为 AI 问答准备会议（{percent}%）。现在即可提问，但在准备完成前，回答可能会遗漏一些细节。',
    'askAi.indexingPaused':
      '录音或笔记生成期间，AI 问答的会议准备工作已暂停（已完成 {percent}%）。仍可提问，但在准备完成前，回答可能会遗漏一些细节。',

    'askAi.scope': '会议范围',
    'askAi.onlyMeeting': '仅此会议：{title}',
    'askAi.removeScope': '移除会议范围',
    'askAi.countReceipt': '已统计 {count} 项：{filter}。',
    'askAi.searchAll': '搜索所有会议',
    'askAi.askMeeting': '询问此会议',
    'askAi.notesPendingOne': '仍在为{title}生成笔记。现在询问 AI 会让笔记生成多花一点时间。',
    'askAi.notesPendingMany': '仍在为{count}场会议生成笔记。现在询问 AI 会让笔记生成多花一点时间。',
    'askAi.countAll': '所有已保存的录音',
    'askAi.countAttached': '附加的已保存录音',
    'askAi.countNoFilters': '无筛选条件',
    'askAi.filterFrom': '{value}及之后',
    'askAi.filterThrough': '{value}及之前',
    'askAi.filterTitle': '标题包含所有词语：{value}',
    'askAi.filterParticipant': '参与者包含所有词语：{value}',
    'askAi.filterKeyword': '笔记或转录包含所有词语：{value}',
    'askAi.filterUnavailable': '筛选详情不可用'
  },
  ko: {
    'askAi.indexingProgress':
      'AI 질문을 위해 회의를 준비하고 있습니다({percent}%). 지금 질문할 수 있지만, 준비가 끝날 때까지 답변에서 일부 세부 정보가 빠질 수 있습니다.',
    'askAi.indexingPaused':
      '녹음 또는 노트 작성 중에는 AI 질문을 위한 회의 준비가 일시 중지됩니다({percent}% 완료). 계속 질문할 수 있지만, 준비가 끝날 때까지 답변에서 일부 세부 정보가 빠질 수 있습니다.',

    'askAi.scope': '회의 범위',
    'askAi.onlyMeeting': '이 회의만: {title}',
    'askAi.removeScope': '회의 범위 해제',
    'askAi.countReceipt': '집계: {count}. 조건: {filter}.',
    'askAi.searchAll': '모든 회의 검색',
    'askAi.askMeeting': '이 회의에 대해 질문',
    'askAi.notesPendingOne':
      '{title}의 노트를 아직 작성 중입니다. 지금 AI에 질문하면 완료까지 시간이 조금 더 걸립니다.',
    'askAi.notesPendingMany':
      '{count}개 회의의 노트를 아직 작성 중입니다. 지금 AI에 질문하면 완료까지 시간이 조금 더 걸립니다.',
    'askAi.countAll': '저장된 모든 녹음',
    'askAi.countAttached': '첨부된 저장 녹음',
    'askAi.countNoFilters': '필터 없음',
    'askAi.filterFrom': '{value} 이후(당일 포함)',
    'askAi.filterThrough': '{value} 이전(당일 포함)',
    'askAi.filterTitle': '제목에 모든 검색어 포함: {value}',
    'askAi.filterParticipant': '참가자에 모든 검색어 포함: {value}',
    'askAi.filterKeyword': '노트 또는 녹취록에 모든 검색어 포함: {value}',
    'askAi.filterUnavailable': '필터 세부 정보를 사용할 수 없음'
  },
  fr: {
    'askAi.indexingProgress':
      'Préparation de vos réunions pour l’IA ({percent} %). Vous pouvez déjà poser des questions, mais les réponses risquent de manquer de détails tant que la préparation n’est pas terminée.',
    'askAi.indexingPaused':
      'La préparation de vos réunions pour l’IA est en pause pendant un enregistrement ou la création de notes ({percent} % terminé). Vous pouvez toujours poser des questions, mais les réponses risquent de manquer de détails tant que la préparation n’est pas terminée.',

    'askAi.scope': 'Périmètre de réunion',
    'askAi.onlyMeeting': 'Cette réunion uniquement : {title}',
    'askAi.removeScope': 'Retirer le périmètre de réunion',
    'askAi.countReceipt': 'Nombre : {count}. Filtre : {filter}.',
    'askAi.searchAll': 'Rechercher dans toutes les réunions',
    'askAi.askMeeting': 'Poser une question sur cette réunion',
    'askAi.notesPendingOne':
      'Les notes de {title} sont encore en cours de création. Poser une question à l’IA maintenant retardera un peu leur finalisation.',
    'askAi.notesPendingMany':
      'Les notes de {count} réunions sont encore en cours de création. Poser une question à l’IA maintenant retardera un peu leur finalisation.',
    'askAi.countAll': 'tous les enregistrements sauvegardés',
    'askAi.countAttached': 'enregistrements sauvegardés joints',
    'askAi.countNoFilters': 'aucun filtre',
    'askAi.filterFrom': 'à partir du {value}',
    'askAi.filterThrough': 'jusqu’au {value} inclus',
    'askAi.filterTitle': 'le titre contient tous les termes : {value}',
    'askAi.filterParticipant': 'le participant contient tous les termes : {value}',
    'askAi.filterKeyword': 'les notes ou la transcription contiennent tous les termes : {value}',
    'askAi.filterUnavailable': 'détails des filtres indisponibles'
  },
  es: {
    'askAi.indexingProgress':
      'Preparando sus reuniones para la IA ({percent} %). Ya puede preguntar, pero las respuestas podrían omitir algunos detalles hasta que termine la preparación.',
    'askAi.indexingPaused':
      'La preparación de sus reuniones para la IA está en pausa mientras se graba o se crean notas ({percent} % completado). Puede seguir preguntando, pero las respuestas podrían omitir algunos detalles hasta que termine la preparación.',

    'askAi.scope': 'Ámbito de reunión',
    'askAi.onlyMeeting': 'Solo esta reunión: {title}',
    'askAi.removeScope': 'Quitar el ámbito de reunión',
    'askAi.countReceipt': 'Recuento: {count}. Filtro: {filter}.',
    'askAi.searchAll': 'Buscar en todas las reuniones',
    'askAi.askMeeting': 'Preguntar sobre esta reunión',
    'askAi.notesPendingOne':
      'Todavía se están creando las notas de {title}. Usar la IA ahora hará que tarden un poco más.',
    'askAi.notesPendingMany':
      'Todavía se están creando las notas de {count} reuniones. Usar la IA ahora hará que tarden un poco más.',
    'askAi.countAll': 'todas las grabaciones guardadas',
    'askAi.countAttached': 'grabaciones guardadas adjuntas',
    'askAi.countNoFilters': 'sin filtros',
    'askAi.filterFrom': 'desde el {value}',
    'askAi.filterThrough': 'hasta el {value} inclusive',
    'askAi.filterTitle': 'el título contiene todos los términos: {value}',
    'askAi.filterParticipant': 'el participante contiene todos los términos: {value}',
    'askAi.filterKeyword': 'las notas o la transcripción contienen todos los términos: {value}',
    'askAi.filterUnavailable': 'detalles del filtro no disponibles'
  },
  it: {
    'askAi.indexingProgress':
      'Preparazione delle riunioni per l’IA ({percent}%). Puoi già fare domande, ma le risposte potrebbero tralasciare alcuni dettagli finché la preparazione non sarà completata.',
    'askAi.indexingPaused':
      'La preparazione delle riunioni per l’IA è in pausa durante una registrazione o la creazione delle note ({percent}% completato). Puoi continuare a fare domande, ma le risposte potrebbero tralasciare alcuni dettagli finché la preparazione non sarà completata.',

    'askAi.scope': 'Ambito della riunione',
    'askAi.onlyMeeting': 'Solo questa riunione: {title}',
    'askAi.removeScope': 'Rimuovi l’ambito della riunione',
    'askAi.countReceipt': 'Conteggio: {count}. Filtro: {filter}.',
    'askAi.searchAll': 'Cerca in tutte le riunioni',
    'askAi.askMeeting': 'Chiedi informazioni su questa riunione',
    'askAi.notesPendingOne':
      'Le note di {title} sono ancora in preparazione. Usare l’IA ora ne rallenterà un po’ il completamento.',
    'askAi.notesPendingMany':
      'Le note di {count} riunioni sono ancora in preparazione. Usare l’IA ora ne rallenterà un po’ il completamento.',
    'askAi.countAll': 'tutte le registrazioni salvate',
    'askAi.countAttached': 'registrazioni salvate allegate',
    'askAi.countNoFilters': 'nessun filtro',
    'askAi.filterFrom': 'dal {value}',
    'askAi.filterThrough': 'fino al {value} incluso',
    'askAi.filterTitle': 'il titolo contiene tutti i termini: {value}',
    'askAi.filterParticipant': 'il partecipante contiene tutti i termini: {value}',
    'askAi.filterKeyword': 'le note o la trascrizione contengono tutti i termini: {value}',
    'askAi.filterUnavailable': 'dettagli dei filtri non disponibili'
  },
  pt: {
    'askAi.indexingProgress':
      'A preparar as suas reuniões para a IA ({percent}%). Já pode fazer perguntas, mas as respostas podem omitir alguns detalhes até a preparação terminar.',
    'askAi.indexingPaused':
      'A preparação das suas reuniões para a IA está em pausa durante uma gravação ou a criação de notas ({percent}% concluído). Pode continuar a fazer perguntas, mas as respostas podem omitir alguns detalhes até a preparação terminar.',

    'askAi.scope': 'Âmbito da reunião',
    'askAi.onlyMeeting': 'Apenas esta reunião: {title}',
    'askAi.removeScope': 'Remover o âmbito da reunião',
    'askAi.countReceipt': 'Contagem: {count}. Filtro: {filter}.',
    'askAi.searchAll': 'Pesquisar em todas as reuniões',
    'askAi.askMeeting': 'Perguntar sobre esta reunião',
    'askAi.notesPendingOne':
      'As notas de {title} ainda estão a ser criadas. Usar a IA agora fará com que demorem um pouco mais.',
    'askAi.notesPendingMany':
      'As notas de {count} reuniões ainda estão a ser criadas. Usar a IA agora fará com que demorem um pouco mais.',
    'askAi.countAll': 'todas as gravações guardadas',
    'askAi.countAttached': 'gravações guardadas anexadas',
    'askAi.countNoFilters': 'sem filtros',
    'askAi.filterFrom': 'a partir de {value}',
    'askAi.filterThrough': 'até {value}, inclusive',
    'askAi.filterTitle': 'o título contém todos os termos: {value}',
    'askAi.filterParticipant': 'o participante contém todos os termos: {value}',
    'askAi.filterKeyword': 'as notas ou a transcrição contêm todos os termos: {value}',
    'askAi.filterUnavailable': 'detalhes dos filtros indisponíveis'
  },
  ru: {
    'askAi.indexingProgress':
      'Подготовка встреч для ИИ ({percent}%). Вы уже можете задавать вопросы, но до завершения подготовки в ответах могут отсутствовать некоторые подробности.',
    'askAi.indexingPaused':
      'Подготовка встреч для ИИ приостановлена на время записи или создания заметок (готово {percent}%). Вы по-прежнему можете задавать вопросы, но до завершения подготовки в ответах могут отсутствовать некоторые подробности.',

    'askAi.scope': 'Область поиска по встречам',
    'askAi.onlyMeeting': 'Только эта встреча: {title}',
    'askAi.removeScope': 'Снять ограничение по встрече',
    'askAi.countReceipt': 'Количество: {count}. Фильтр: {filter}.',
    'askAi.searchAll': 'Искать по всем встречам',
    'askAi.askMeeting': 'Спросить об этой встрече',
    'askAi.notesPendingOne':
      'Заметки для «{title}» ещё создаются. Если сейчас задать вопрос ИИ, их создание займёт немного больше времени.',
    'askAi.notesPendingMany':
      'Ещё создаются заметки для встреч: {count}. Если сейчас задать вопрос ИИ, их создание займёт немного больше времени.',
    'askAi.countAll': 'все сохранённые записи',
    'askAi.countAttached': 'прикреплённые сохранённые записи',
    'askAi.countNoFilters': 'без фильтров',
    'askAi.filterFrom': 'начиная с {value}',
    'askAi.filterThrough': 'до {value} включительно',
    'askAi.filterTitle': 'название содержит все слова: {value}',
    'askAi.filterParticipant': 'участник содержит все слова: {value}',
    'askAi.filterKeyword': 'заметки или расшифровка содержат все слова: {value}',
    'askAi.filterUnavailable': 'сведения о фильтрах недоступны'
  },
  uk: {
    'askAi.indexingProgress':
      'Підготовка зустрічей для ШІ ({percent}%). Уже можна ставити запитання, але до завершення підготовки у відповідях можуть бути відсутні деякі подробиці.',
    'askAi.indexingPaused':
      'Підготовку зустрічей для ШІ призупинено на час запису або створення нотаток (готово {percent}%). Ви й далі можете ставити запитання, але до завершення підготовки у відповідях можуть бути відсутні деякі подробиці.',

    'askAi.scope': 'Область пошуку зустрічей',
    'askAi.onlyMeeting': 'Лише ця зустріч: {title}',
    'askAi.removeScope': 'Зняти обмеження за зустріччю',
    'askAi.countReceipt': 'Кількість: {count}. Фільтр: {filter}.',
    'askAi.searchAll': 'Шукати в усіх зустрічах',
    'askAi.askMeeting': 'Запитати про цю зустріч',
    'askAi.notesPendingOne':
      'Нотатки для «{title}» ще створюються. Якщо зараз поставити запитання ШІ, їх створення триватиме трохи довше.',
    'askAi.notesPendingMany':
      'Ще створюються нотатки для зустрічей: {count}. Якщо зараз поставити запитання ШІ, їх створення триватиме трохи довше.',
    'askAi.countAll': 'усі збережені записи',
    'askAi.countAttached': 'прикріплені збережені записи',
    'askAi.countNoFilters': 'без фільтрів',
    'askAi.filterFrom': 'починаючи з {value}',
    'askAi.filterThrough': 'до {value} включно',
    'askAi.filterTitle': 'назва містить усі слова: {value}',
    'askAi.filterParticipant': 'учасник містить усі слова: {value}',
    'askAi.filterKeyword': 'нотатки або розшифровка містять усі слова: {value}',
    'askAi.filterUnavailable': 'відомості про фільтри недоступні'
  },
  bg: {
    'askAi.indexingProgress':
      'Срещите ви се подготвят за AI ({percent}%). Можете да задавате въпроси още сега, но в отговорите може да липсват някои подробности, докато подготовката приключи.',
    'askAi.indexingPaused':
      'Подготовката на срещите ви за AI е на пауза, докато се прави запис или се създават бележки ({percent}% готово). Все още можете да задавате въпроси, но в отговорите може да липсват някои подробности, докато подготовката приключи.',

    'askAi.scope': 'Обхват на срещата',
    'askAi.onlyMeeting': 'Само тази среща: {title}',
    'askAi.removeScope': 'Премахване на обхвата на срещата',
    'askAi.countReceipt': 'Брой: {count}. Филтър: {filter}.',
    'askAi.searchAll': 'Търсене във всички срещи',
    'askAi.askMeeting': 'Въпрос за тази среща',
    'askAi.notesPendingOne':
      'Бележките за „{title}“ все още се създават. Ако сега зададете въпрос на ИИ, създаването им ще отнеме малко повече време.',
    'askAi.notesPendingMany':
      'Все още се създават бележки за срещи: {count}. Ако сега зададете въпрос на ИИ, създаването им ще отнеме малко повече време.',
    'askAi.countAll': 'всички запазени записи',
    'askAi.countAttached': 'прикачените запазени записи',
    'askAi.countNoFilters': 'без филтри',
    'askAi.filterFrom': 'от {value} нататък',
    'askAi.filterThrough': 'до {value} включително',
    'askAi.filterTitle': 'заглавието съдържа всички думи: {value}',
    'askAi.filterParticipant': 'участникът съдържа всички думи: {value}',
    'askAi.filterKeyword': 'бележките или транскрипцията съдържат всички думи: {value}',
    'askAi.filterUnavailable': 'подробностите за филтрите не са налични'
  },
  hr: {
    'askAi.indexingProgress':
      'Priprema sastanaka za AI ({percent} %). Već možete postavljati pitanja, ali dok priprema ne završi, u odgovorima mogu nedostajati pojedinosti.',
    'askAi.indexingPaused':
      'Priprema sastanaka za AI pauzirana je tijekom snimanja ili izrade bilježaka ({percent} % dovršeno). I dalje možete postavljati pitanja, ali dok priprema ne završi, u odgovorima mogu nedostajati pojedinosti.',

    'askAi.scope': 'Opseg sastanka',
    'askAi.onlyMeeting': 'Samo ovaj sastanak: {title}',
    'askAi.removeScope': 'Ukloni opseg sastanka',
    'askAi.countReceipt': 'Broj: {count}. Filtar: {filter}.',
    'askAi.searchAll': 'Pretraži sve sastanke',
    'askAi.askMeeting': 'Pitaj o ovom sastanku',
    'askAi.notesPendingOne':
      'Bilješke za „{title}” još se izrađuju. Ako sada pitate AI, njihova će izrada trajati malo dulje.',
    'askAi.notesPendingMany':
      'Broj sastanaka za koje se bilješke još izrađuju: {count}. Ako sada pitate AI, njihova će izrada trajati malo dulje.',
    'askAi.countAll': 'sve spremljene snimke',
    'askAi.countAttached': 'priložene spremljene snimke',
    'askAi.countNoFilters': 'bez filtara',
    'askAi.filterFrom': 'od {value}',
    'askAi.filterThrough': 'do uključivo {value}',
    'askAi.filterTitle': 'naslov sadrži sve pojmove: {value}',
    'askAi.filterParticipant': 'sudionik sadrži sve pojmove: {value}',
    'askAi.filterKeyword': 'bilješke ili transkript sadrže sve pojmove: {value}',
    'askAi.filterUnavailable': 'pojedinosti filtara nisu dostupne'
  },
  cs: {
    'askAi.indexingProgress':
      'Příprava schůzek pro AI ({percent} %). Ptát se můžete už teď, ale do dokončení přípravy mohou v odpovědích chybět některé podrobnosti.',
    'askAi.indexingPaused':
      'Příprava schůzek pro AI je během nahrávání nebo vytváření poznámek pozastavena ({percent} % hotovo). Stále se můžete ptát, ale do dokončení přípravy mohou v odpovědích chybět některé podrobnosti.',

    'askAi.scope': 'Rozsah schůzky',
    'askAi.onlyMeeting': 'Pouze tato schůzka: {title}',
    'askAi.removeScope': 'Zrušit omezení na schůzku',
    'askAi.countReceipt': 'Počet: {count}. Filtr: {filter}.',
    'askAi.searchAll': 'Hledat ve všech schůzkách',
    'askAi.askMeeting': 'Zeptat se na tuto schůzku',
    'askAi.notesPendingOne':
      'Poznámky ke schůzce „{title}“ se stále vytvářejí. Pokud se nyní zeptáte AI, jejich tvorba potrvá o něco déle.',
    'askAi.notesPendingMany':
      'Počet schůzek, ke kterým se ještě vytvářejí poznámky: {count}. Pokud se nyní zeptáte AI, jejich tvorba potrvá o něco déle.',
    'askAi.countAll': 'všechny uložené nahrávky',
    'askAi.countAttached': 'připojené uložené nahrávky',
    'askAi.countNoFilters': 'bez filtrů',
    'askAi.filterFrom': 'od {value}',
    'askAi.filterThrough': 'do {value} včetně',
    'askAi.filterTitle': 'název obsahuje všechny výrazy: {value}',
    'askAi.filterParticipant': 'účastník obsahuje všechny výrazy: {value}',
    'askAi.filterKeyword': 'poznámky nebo přepis obsahují všechny výrazy: {value}',
    'askAi.filterUnavailable': 'podrobnosti filtrů nejsou k dispozici'
  },
  da: {
    'askAi.indexingProgress':
      'Dine møder gøres klar til AI ({percent} %). Du kan spørge nu, men svarene kan mangle nogle detaljer, indtil forberedelsen er færdig.',
    'askAi.indexingPaused':
      'Klargøringen af dine møder til AI er sat på pause, mens der optages eller laves noter ({percent} % færdig). Du kan stadig spørge, men svarene kan mangle nogle detaljer, indtil forberedelsen er færdig.',

    'askAi.scope': 'Mødeafgrænsning',
    'askAi.onlyMeeting': 'Kun dette møde: {title}',
    'askAi.removeScope': 'Fjern mødeafgrænsning',
    'askAi.countReceipt': 'Antal: {count}. Filter: {filter}.',
    'askAi.searchAll': 'Søg i alle møder',
    'askAi.askMeeting': 'Spørg om dette møde',
    'askAi.notesPendingOne':
      'Noterne til {title} er stadig ved at blive lavet. Hvis du spørger AI nu, vil det tage lidt længere tid.',
    'askAi.notesPendingMany':
      'Noterne til {count} møder er stadig ved at blive lavet. Hvis du spørger AI nu, vil det tage lidt længere tid.',
    'askAi.countAll': 'alle gemte optagelser',
    'askAi.countAttached': 'vedhæftede gemte optagelser',
    'askAi.countNoFilters': 'ingen filtre',
    'askAi.filterFrom': 'fra og med {value}',
    'askAi.filterThrough': 'til og med {value}',
    'askAi.filterTitle': 'titlen indeholder alle ordene: {value}',
    'askAi.filterParticipant': 'deltageren indeholder alle ordene: {value}',
    'askAi.filterKeyword': 'noter eller transskription indeholder alle ordene: {value}',
    'askAi.filterUnavailable': 'filteroplysninger er ikke tilgængelige'
  },
  nl: {
    'askAi.indexingProgress':
      'Uw vergaderingen worden voorbereid voor AI ({percent}%). U kunt al vragen stellen, maar de antwoorden kunnen details missen totdat de voorbereiding klaar is.',
    'askAi.indexingPaused':
      'De voorbereiding van uw vergaderingen voor AI is gepauzeerd tijdens een opname of het maken van notities ({percent}% voltooid). U kunt vragen blijven stellen, maar de antwoorden kunnen details missen totdat de voorbereiding klaar is.',

    'askAi.scope': 'Vergaderbereik',
    'askAi.onlyMeeting': 'Alleen deze vergadering: {title}',
    'askAi.removeScope': 'Vergaderbereik verwijderen',
    'askAi.countReceipt': 'Geteld: {count}. Filter: {filter}.',
    'askAi.searchAll': 'Alle vergaderingen doorzoeken',
    'askAi.askMeeting': 'Vragen over deze vergadering',
    'askAi.notesPendingOne':
      'De notities voor {title} worden nog gemaakt. Als je de AI nu iets vraagt, duurt dat iets langer.',
    'askAi.notesPendingMany':
      'De notities voor {count} vergaderingen worden nog gemaakt. Als je de AI nu iets vraagt, duurt dat iets langer.',
    'askAi.countAll': 'alle opgeslagen opnamen',
    'askAi.countAttached': 'bijgevoegde opgeslagen opnamen',
    'askAi.countNoFilters': 'geen filters',
    'askAi.filterFrom': 'vanaf {value}',
    'askAi.filterThrough': 'tot en met {value}',
    'askAi.filterTitle': 'titel bevat alle termen: {value}',
    'askAi.filterParticipant': 'deelnemer bevat alle termen: {value}',
    'askAi.filterKeyword': 'notities of transcript bevatten alle termen: {value}',
    'askAi.filterUnavailable': 'filterdetails niet beschikbaar'
  },
  et: {
    'askAi.indexingProgress':
      'Koosolekute ettevalmistamine tehisintellekti jaoks ({percent}%). Võite juba küsida, kuid kuni ettevalmistus lõpeb, võivad vastustest mõned üksikasjad puududa.',
    'askAi.indexingPaused':
      'Koosolekute ettevalmistamine tehisintellekti jaoks on salvestamise või märkmete koostamise ajaks peatatud ({percent}% valmis). Võite endiselt küsida, kuid kuni ettevalmistus lõpeb, võivad vastustest mõned üksikasjad puududa.',

    'askAi.scope': 'Koosoleku ulatus',
    'askAi.onlyMeeting': 'Ainult see koosolek: {title}',
    'askAi.removeScope': 'Eemalda koosoleku piirang',
    'askAi.countReceipt': 'Arv: {count}. Filter: {filter}.',
    'askAi.searchAll': 'Otsi kõigist koosolekutest',
    'askAi.askMeeting': 'Küsi selle koosoleku kohta',
    'askAi.notesPendingOne':
      'Koosoleku „{title}“ märkmeid alles koostatakse. Kui küsid praegu tehisarult, võtab nende valmimine veidi kauem aega.',
    'askAi.notesPendingMany':
      'Märkmeid koostatakse veel {count} koosoleku jaoks. Kui küsid praegu tehisarult, võtab nende valmimine veidi kauem aega.',
    'askAi.countAll': 'kõik salvestatud salvestised',
    'askAi.countAttached': 'lisatud salvestised',
    'askAi.countNoFilters': 'filtriteta',
    'askAi.filterFrom': 'alates {value}',
    'askAi.filterThrough': 'kuni {value}, kaasa arvatud',
    'askAi.filterTitle': 'pealkiri sisaldab kõiki sõnu: {value}',
    'askAi.filterParticipant': 'osaleja sisaldab kõiki sõnu: {value}',
    'askAi.filterKeyword': 'märkmed või transkriptsioon sisaldavad kõiki sõnu: {value}',
    'askAi.filterUnavailable': 'filtri üksikasjad pole saadaval'
  },
  fi: {
    'askAi.indexingProgress':
      'Kokouksiasi valmistellaan tekoälyä varten ({percent} %). Voit kysyä jo nyt, mutta vastauksista voi puuttua yksityiskohtia, kunnes valmistelu on valmis.',
    'askAi.indexingPaused':
      'Kokousten valmistelu tekoälyä varten on keskeytetty tallennuksen tai muistiinpanojen laatimisen ajaksi ({percent} % valmiina). Voit silti kysyä, mutta vastauksista voi puuttua yksityiskohtia, kunnes valmistelu on valmis.',

    'askAi.scope': 'Kokouksen rajaus',
    'askAi.onlyMeeting': 'Vain tämä kokous: {title}',
    'askAi.removeScope': 'Poista kokousrajaus',
    'askAi.countReceipt': 'Määrä: {count}. Suodatin: {filter}.',
    'askAi.searchAll': 'Hae kaikista kokouksista',
    'askAi.askMeeting': 'Kysy tästä kokouksesta',
    'askAi.notesPendingOne':
      'Kokouksen {title} muistiinpanoja luodaan vielä. Jos kysyt nyt tekoälyltä, niiden valmistuminen kestää hieman kauemmin.',
    'askAi.notesPendingMany':
      'Kokouksia, joiden muistiinpanot ovat vielä kesken: {count}. Jos kysyt nyt tekoälyltä, niiden valmistuminen kestää hieman kauemmin.',
    'askAi.countAll': 'kaikki tallennetut tallenteet',
    'askAi.countAttached': 'liitetyt tallennetut tallenteet',
    'askAi.countNoFilters': 'ei suodattimia',
    'askAi.filterFrom': '{value} alkaen',
    'askAi.filterThrough': '{value} asti, päivä mukaan lukien',
    'askAi.filterTitle': 'otsikko sisältää kaikki sanat: {value}',
    'askAi.filterParticipant': 'osallistuja sisältää kaikki sanat: {value}',
    'askAi.filterKeyword': 'muistiinpanot tai litterointi sisältävät kaikki sanat: {value}',
    'askAi.filterUnavailable': 'suodattimen tietoja ei ole saatavilla'
  },
  el: {
    'askAi.indexingProgress':
      'Προετοιμασία των συναντήσεών σας για την AI ({percent}%). Μπορείτε ήδη να κάνετε ερωτήσεις, αλλά μέχρι να ολοκληρωθεί η προετοιμασία ίσως λείπουν ορισμένες λεπτομέρειες από τις απαντήσεις.',
    'askAi.indexingPaused':
      'Η προετοιμασία των συναντήσεών σας για την AI έχει διακοπεί προσωρινά όσο γίνεται εγγραφή ή δημιουργούνται σημειώσεις ({percent}% ολοκληρώθηκε). Μπορείτε να συνεχίσετε να κάνετε ερωτήσεις, αλλά μέχρι να ολοκληρωθεί η προετοιμασία ίσως λείπουν ορισμένες λεπτομέρειες από τις απαντήσεις.',

    'askAi.scope': 'Πεδίο σύσκεψης',
    'askAi.onlyMeeting': 'Μόνο αυτή η σύσκεψη: {title}',
    'askAi.removeScope': 'Κατάργηση περιορισμού σύσκεψης',
    'askAi.countReceipt': 'Πλήθος: {count}. Φίλτρο: {filter}.',
    'askAi.searchAll': 'Αναζήτηση σε όλες τις συσκέψεις',
    'askAi.askMeeting': 'Ερώτηση για αυτή τη σύσκεψη',
    'askAi.notesPendingOne':
      'Οι σημειώσεις για τη σύσκεψη «{title}» δημιουργούνται ακόμη. Αν ρωτήσετε τώρα την ΤΝ, θα χρειαστούν λίγο περισσότερο χρόνο.',
    'askAi.notesPendingMany':
      'Οι σημειώσεις για {count} συσκέψεις δημιουργούνται ακόμη. Αν ρωτήσετε τώρα την ΤΝ, θα χρειαστούν λίγο περισσότερο χρόνο.',
    'askAi.countAll': 'όλες οι αποθηκευμένες εγγραφές',
    'askAi.countAttached': 'οι συνημμένες αποθηκευμένες εγγραφές',
    'askAi.countNoFilters': 'χωρίς φίλτρα',
    'askAi.filterFrom': 'από {value} και μετά',
    'askAi.filterThrough': 'έως και {value}',
    'askAi.filterTitle': 'ο τίτλος περιέχει όλους τους όρους: {value}',
    'askAi.filterParticipant': 'ο συμμετέχων περιέχει όλους τους όρους: {value}',
    'askAi.filterKeyword': 'οι σημειώσεις ή η απομαγνητοφώνηση περιέχουν όλους τους όρους: {value}',
    'askAi.filterUnavailable': 'οι λεπτομέρειες φίλτρων δεν είναι διαθέσιμες'
  },
  hu: {
    'askAi.indexingProgress':
      'Megbeszélések előkészítése az AI számára ({percent}%). Már most is kérdezhet, de az előkészítés végéig egyes részletek hiányozhatnak a válaszokból.',
    'askAi.indexingPaused':
      'A megbeszélések AI számára történő előkészítése szünetel a felvétel vagy a jegyzetkészítés idejére ({percent}% kész). Továbbra is kérdezhet, de az előkészítés végéig egyes részletek hiányozhatnak a válaszokból.',

    'askAi.scope': 'Értekezlet hatóköre',
    'askAi.onlyMeeting': 'Csak ez az értekezlet: {title}',
    'askAi.removeScope': 'Értekezletszűrés eltávolítása',
    'askAi.countReceipt': 'Darabszám: {count}. Szűrő: {filter}.',
    'askAi.searchAll': 'Keresés minden értekezletben',
    'askAi.askMeeting': 'Kérdés erről az értekezletről',
    'askAi.notesPendingOne':
      'A(z) {title} jegyzetei még készülnek. Ha most kérdez az MI-től, egy kicsit tovább tart az elkészítésük.',
    'askAi.notesPendingMany':
      'Még készülnek a jegyzetek {count} értekezlethez. Ha most kérdez az MI-től, egy kicsit tovább tart az elkészítésük.',
    'askAi.countAll': 'az összes mentett felvétel',
    'askAi.countAttached': 'a csatolt mentett felvételek',
    'askAi.countNoFilters': 'nincs szűrő',
    'askAi.filterFrom': '{value} dátumtól',
    'askAi.filterThrough': '{value} dátumig, azt is beleértve',
    'askAi.filterTitle': 'a cím minden kifejezést tartalmaz: {value}',
    'askAi.filterParticipant': 'a résztvevő minden kifejezést tartalmaz: {value}',
    'askAi.filterKeyword': 'a jegyzetek vagy az átirat minden kifejezést tartalmaz: {value}',
    'askAi.filterUnavailable': 'a szűrő részletei nem érhetők el'
  },
  lv: {
    'askAi.indexingProgress':
      'Notiek sapulču sagatavošana MI ({percent}%). Jau varat uzdot jautājumus, taču līdz sagatavošanas beigām atbildēs var trūkt dažu detaļu.',
    'askAi.indexingPaused':
      'Sapulču sagatavošana MI ir apturēta ierakstīšanas vai piezīmju veidošanas laikā ({percent}% pabeigti). Joprojām varat uzdot jautājumus, taču līdz sagatavošanas beigām atbildēs var trūkt dažu detaļu.',

    'askAi.scope': 'Sanāksmes tvērums',
    'askAi.onlyMeeting': 'Tikai šī sanāksme: {title}',
    'askAi.removeScope': 'Noņemt sanāksmes ierobežojumu',
    'askAi.countReceipt': 'Skaits: {count}. Filtrs: {filter}.',
    'askAi.searchAll': 'Meklēt visās sanāksmēs',
    'askAi.askMeeting': 'Jautāt par šo sanāksmi',
    'askAi.notesPendingOne':
      'Sanāksmes “{title}” piezīmes vēl tiek veidotas. Ja tagad jautāsiet MI, to izveide prasīs nedaudz ilgāku laiku.',
    'askAi.notesPendingMany':
      'Sanāksmes, kurām piezīmes vēl tiek veidotas: {count}. Ja tagad jautāsiet MI, to izveide prasīs nedaudz ilgāku laiku.',
    'askAi.countAll': 'visi saglabātie ieraksti',
    'askAi.countAttached': 'pievienotie saglabātie ieraksti',
    'askAi.countNoFilters': 'bez filtriem',
    'askAi.filterFrom': 'no {value}',
    'askAi.filterThrough': 'līdz {value}, ieskaitot',
    'askAi.filterTitle': 'virsraksts ietver visus vārdus: {value}',
    'askAi.filterParticipant': 'dalībnieks ietver visus vārdus: {value}',
    'askAi.filterKeyword': 'piezīmes vai transkripcija ietver visus vārdus: {value}',
    'askAi.filterUnavailable': 'filtra informācija nav pieejama'
  },
  lt: {
    'askAi.indexingProgress':
      'Ruošiami susitikimai DI ({percent} %). Jau galite klausti, tačiau kol pasiruošimas nebaigtas, atsakymuose gali trūkti kai kurių detalių.',
    'askAi.indexingPaused':
      'Susitikimų ruošimas DI pristabdytas, kol įrašoma arba kuriami užrašai ({percent} % baigta). Vis dar galite klausti, tačiau kol pasiruošimas nebaigtas, atsakymuose gali trūkti kai kurių detalių.',

    'askAi.scope': 'Susitikimo aprėptis',
    'askAi.onlyMeeting': 'Tik šis susitikimas: {title}',
    'askAi.removeScope': 'Pašalinti susitikimo apribojimą',
    'askAi.countReceipt': 'Skaičius: {count}. Filtras: {filter}.',
    'askAi.searchAll': 'Ieškoti visuose susitikimuose',
    'askAi.askMeeting': 'Klausti apie šį susitikimą',
    'askAi.notesPendingOne':
      'Susitikimo „{title}“ pastabos dar rengiamos. Jei dabar klausite DI, jų rengimas užtruks šiek tiek ilgiau.',
    'askAi.notesPendingMany':
      'Susitikimų, kurių pastabos dar rengiamos, skaičius: {count}. Jei dabar klausite DI, jų rengimas užtruks šiek tiek ilgiau.',
    'askAi.countAll': 'visi išsaugoti įrašai',
    'askAi.countAttached': 'pridėti išsaugoti įrašai',
    'askAi.countNoFilters': 'be filtrų',
    'askAi.filterFrom': 'nuo {value}',
    'askAi.filterThrough': 'iki {value} imtinai',
    'askAi.filterTitle': 'pavadinime yra visi žodžiai: {value}',
    'askAi.filterParticipant': 'dalyvio varde yra visi žodžiai: {value}',
    'askAi.filterKeyword': 'pastabose arba transkripcijoje yra visi žodžiai: {value}',
    'askAi.filterUnavailable': 'filtro informacija nepasiekiama'
  },
  pl: {
    'askAi.indexingProgress':
      'Przygotowywanie spotkań dla AI ({percent}%). Możesz już zadawać pytania, ale do zakończenia przygotowań w odpowiedziach może brakować niektórych szczegółów.',
    'askAi.indexingPaused':
      'Przygotowywanie spotkań dla AI jest wstrzymane na czas nagrywania lub tworzenia notatek (ukończono {percent}%). Nadal możesz zadawać pytania, ale do zakończenia przygotowań w odpowiedziach może brakować niektórych szczegółów.',

    'askAi.scope': 'Zakres spotkania',
    'askAi.onlyMeeting': 'Tylko to spotkanie: {title}',
    'askAi.removeScope': 'Usuń ograniczenie do spotkania',
    'askAi.countReceipt': 'Liczba: {count}. Filtr: {filter}.',
    'askAi.searchAll': 'Szukaj we wszystkich spotkaniach',
    'askAi.askMeeting': 'Zapytaj o to spotkanie',
    'askAi.notesPendingOne':
      'Notatki ze spotkania „{title}” są jeszcze tworzone. Jeśli teraz zapytasz AI, ich przygotowanie potrwa nieco dłużej.',
    'askAi.notesPendingMany':
      'Liczba spotkań, z których notatki są jeszcze tworzone: {count}. Jeśli teraz zapytasz AI, ich przygotowanie potrwa nieco dłużej.',
    'askAi.countAll': 'wszystkie zapisane nagrania',
    'askAi.countAttached': 'dołączone zapisane nagrania',
    'askAi.countNoFilters': 'bez filtrów',
    'askAi.filterFrom': 'od {value}',
    'askAi.filterThrough': 'do {value} włącznie',
    'askAi.filterTitle': 'tytuł zawiera wszystkie słowa: {value}',
    'askAi.filterParticipant': 'uczestnik zawiera wszystkie słowa: {value}',
    'askAi.filterKeyword': 'notatki lub transkrypcja zawierają wszystkie słowa: {value}',
    'askAi.filterUnavailable': 'szczegóły filtrów są niedostępne'
  },
  ro: {
    'askAi.indexingProgress':
      'Se pregătesc întâlnirile pentru AI ({percent}%). Puteți pune deja întrebări, dar răspunsurile pot omite unele detalii până la finalizarea pregătirii.',
    'askAi.indexingPaused':
      'Pregătirea întâlnirilor pentru AI este întreruptă cât timp se înregistrează sau se creează notițe ({percent}% finalizat). Puteți pune în continuare întrebări, dar răspunsurile pot omite unele detalii până la finalizarea pregătirii.',

    'askAi.scope': 'Domeniul întâlnirii',
    'askAi.onlyMeeting': 'Doar această întâlnire: {title}',
    'askAi.removeScope': 'Elimină restricția la întâlnire',
    'askAi.countReceipt': 'Număr: {count}. Filtru: {filter}.',
    'askAi.searchAll': 'Caută în toate întâlnirile',
    'askAi.askMeeting': 'Întreabă despre această întâlnire',
    'askAi.notesPendingOne':
      'Notițele pentru „{title}” sunt încă în curs de creare. Dacă întrebați IA acum, crearea lor va dura puțin mai mult.',
    'askAi.notesPendingMany':
      'Întâlniri pentru care notițele sunt încă în curs de creare: {count}. Dacă întrebați IA acum, crearea lor va dura puțin mai mult.',
    'askAi.countAll': 'toate înregistrările salvate',
    'askAi.countAttached': 'înregistrările salvate atașate',
    'askAi.countNoFilters': 'fără filtre',
    'askAi.filterFrom': 'începând cu {value}',
    'askAi.filterThrough': 'până la {value} inclusiv',
    'askAi.filterTitle': 'titlul conține toți termenii: {value}',
    'askAi.filterParticipant': 'participantul conține toți termenii: {value}',
    'askAi.filterKeyword': 'notițele sau transcrierea conțin toți termenii: {value}',
    'askAi.filterUnavailable': 'detaliile filtrelor nu sunt disponibile'
  },
  sk: {
    'askAi.indexingProgress':
      'Príprava stretnutí pre AI ({percent} %). Pýtať sa môžete už teraz, ale do dokončenia prípravy môžu v odpovediach chýbať niektoré podrobnosti.',
    'askAi.indexingPaused':
      'Príprava stretnutí pre AI je počas nahrávania alebo vytvárania poznámok pozastavená ({percent} % hotovo). Stále sa môžete pýtať, ale do dokončenia prípravy môžu v odpovediach chýbať niektoré podrobnosti.',

    'askAi.scope': 'Rozsah schôdze',
    'askAi.onlyMeeting': 'Iba táto schôdza: {title}',
    'askAi.removeScope': 'Zrušiť obmedzenie na schôdzu',
    'askAi.countReceipt': 'Počet: {count}. Filter: {filter}.',
    'askAi.searchAll': 'Hľadať vo všetkých schôdzach',
    'askAi.askMeeting': 'Opýtať sa na túto schôdzu',
    'askAi.notesPendingOne':
      'Poznámky zo schôdze „{title}“ sa ešte vytvárajú. Ak sa teraz opýtate AI, ich tvorba potrvá o niečo dlhšie.',
    'askAi.notesPendingMany':
      'Počet schôdzí, ku ktorým sa ešte vytvárajú poznámky: {count}. Ak sa teraz opýtate AI, ich tvorba potrvá o niečo dlhšie.',
    'askAi.countAll': 'všetky uložené nahrávky',
    'askAi.countAttached': 'pripojené uložené nahrávky',
    'askAi.countNoFilters': 'bez filtrov',
    'askAi.filterFrom': 'od {value}',
    'askAi.filterThrough': 'do {value} vrátane',
    'askAi.filterTitle': 'názov obsahuje všetky výrazy: {value}',
    'askAi.filterParticipant': 'účastník obsahuje všetky výrazy: {value}',
    'askAi.filterKeyword': 'poznámky alebo prepis obsahujú všetky výrazy: {value}',
    'askAi.filterUnavailable': 'podrobnosti filtrov nie sú k dispozícii'
  },
  sl: {
    'askAi.indexingProgress':
      'Priprava sestankov za AI ({percent} %). Vprašanja lahko postavljate že zdaj, vendar lahko do konca priprave v odgovorih manjkajo nekatere podrobnosti.',
    'askAi.indexingPaused':
      'Priprava sestankov za AI je začasno ustavljena med snemanjem ali ustvarjanjem zapiskov ({percent} % končano). Še vedno lahko postavljate vprašanja, vendar lahko do konca priprave v odgovorih manjkajo nekatere podrobnosti.',

    'askAi.scope': 'Obseg sestanka',
    'askAi.onlyMeeting': 'Samo ta sestanek: {title}',
    'askAi.removeScope': 'Odstrani omejitev na sestanek',
    'askAi.countReceipt': 'Število: {count}. Filter: {filter}.',
    'askAi.searchAll': 'Išči po vseh sestankih',
    'askAi.askMeeting': 'Vprašaj o tem sestanku',
    'askAi.notesPendingOne':
      'Zapiski za sestanek »{title}« se še ustvarjajo. Če zdaj vprašate UI, bo njihova priprava trajala nekoliko dlje.',
    'askAi.notesPendingMany':
      'Število sestankov, za katere se zapiski še ustvarjajo: {count}. Če zdaj vprašate UI, bo njihova priprava trajala nekoliko dlje.',
    'askAi.countAll': 'vsi shranjeni posnetki',
    'askAi.countAttached': 'priloženi shranjeni posnetki',
    'askAi.countNoFilters': 'brez filtrov',
    'askAi.filterFrom': 'od {value}',
    'askAi.filterThrough': 'do vključno {value}',
    'askAi.filterTitle': 'naslov vsebuje vse izraze: {value}',
    'askAi.filterParticipant': 'udeleženec vsebuje vse izraze: {value}',
    'askAi.filterKeyword': 'zapiski ali prepis vsebujejo vse izraze: {value}',
    'askAi.filterUnavailable': 'podrobnosti filtrov niso na voljo'
  },
  sv: {
    'askAi.indexingProgress':
      'Förbereder dina möten för AI ({percent} %). Du kan fråga redan nu, men svaren kan sakna vissa detaljer tills förberedelsen är klar.',
    'askAi.indexingPaused':
      'Förberedelsen av dina möten för AI är pausad medan en inspelning eller anteckningar pågår ({percent} % klart). Du kan fortfarande fråga, men svaren kan sakna vissa detaljer tills förberedelsen är klar.',

    'askAi.scope': 'Mötesavgränsning',
    'askAi.onlyMeeting': 'Endast detta möte: {title}',
    'askAi.removeScope': 'Ta bort mötesavgränsning',
    'askAi.countReceipt': 'Antal: {count}. Filter: {filter}.',
    'askAi.searchAll': 'Sök i alla möten',
    'askAi.askMeeting': 'Fråga om det här mötet',
    'askAi.notesPendingOne':
      'Anteckningarna för {title} håller fortfarande på att skapas. Om du frågar AI nu tar det lite längre tid.',
    'askAi.notesPendingMany':
      'Anteckningarna för {count} möten håller fortfarande på att skapas. Om du frågar AI nu tar det lite längre tid.',
    'askAi.countAll': 'alla sparade inspelningar',
    'askAi.countAttached': 'bifogade sparade inspelningar',
    'askAi.countNoFilters': 'inga filter',
    'askAi.filterFrom': 'från och med {value}',
    'askAi.filterThrough': 'till och med {value}',
    'askAi.filterTitle': 'titeln innehåller alla orden: {value}',
    'askAi.filterParticipant': 'deltagaren innehåller alla orden: {value}',
    'askAi.filterKeyword': 'anteckningar eller transkription innehåller alla orden: {value}',
    'askAi.filterUnavailable': 'filterdetaljer är inte tillgängliga'
  }
}
