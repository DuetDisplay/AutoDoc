import type { UiLanguageCode } from '../../ui-language'
import type { en } from './en'

export const askAiOverlays: Record<
  Exclude<UiLanguageCode, 'en'>,
  Partial<Record<keyof typeof en, string>>
> = {
  de: {
    'askAi.coverage': 'Grundlage: {passages} aus {meetings} von insgesamt {totalMeetings}.',
    'count.passages.zero': '{count} Passagen',
    'count.passages.one': '{count} Passage',
    'count.passages.two': '{count} Passagen',
    'count.passages.few': '{count} Passagen',
    'count.passages.many': '{count} Passagen',
    'count.passages.other': '{count} Passagen',
    'askAi.indexingPreparingAnnouncement': 'Ihre Besprechungen werden für „KI fragen“ vorbereitet.',
    'askAi.indexingPausedAnnouncement':
      'Die Vorbereitung für „KI fragen“ pausiert, während eine Besprechung aufgenommen wird oder Notizen erstellt werden.',

    'askAi.indexingStarting':
      'Ihre Besprechungen werden für „KI fragen“ vorbereitet. Sie können jetzt fragen, aber bis zum Abschluss können Antworten Details auslassen.',
    'askAi.indexingProgress':
      'Ihre Besprechungen werden für „KI fragen“ vorbereitet ({percent} %). Sie können jetzt fragen, aber bis zum Abschluss können Antworten Details auslassen.',
    'askAi.indexingPaused':
      'Die Vorbereitung für „KI fragen“ pausiert bei {percent} %, während eine Besprechung aufgenommen wird oder Notizen erstellt werden. Danach geht es automatisch weiter. Bis dahin können Antworten Details auslassen.',

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
    'askAi.coverage': '{totalMeetings}のうち{meetings}件の会議からの{passages}に基づいています。',
    'count.passages.zero': '{count}件の抜粋',
    'count.passages.one': '{count}件の抜粋',
    'count.passages.two': '{count}件の抜粋',
    'count.passages.few': '{count}件の抜粋',
    'count.passages.many': '{count}件の抜粋',
    'count.passages.other': '{count}件の抜粋',
    'askAi.indexingPreparingAnnouncement': 'AIに質問できるよう会議を準備しています。',
    'askAi.indexingPausedAnnouncement':
      '会議の録音中またはノートの作成中のため、AIに質問するための準備を一時停止しています。',

    'askAi.indexingStarting':
      'AIに質問できるよう会議を準備しています。今すぐ質問できますが、完了までは回答に一部の詳細が含まれない場合があります。',
    'askAi.indexingProgress':
      'AIに質問できるよう会議を準備しています（{percent}%）。今すぐ質問できますが、完了までは回答に一部の詳細が含まれない場合があります。',
    'askAi.indexingPaused':
      '会議の録音中またはノートの作成中のため、AIに質問するための準備を{percent}%で一時停止しています。その後、自動的に再開します。それまでは回答に一部の詳細が含まれない場合があります。',

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
    'askAi.coverage': '依据 {passages}；涉及会议：{meetings}，会议总数：{totalMeetings}。',
    'count.passages.zero': '{count}段摘录',
    'count.passages.one': '{count}段摘录',
    'count.passages.two': '{count}段摘录',
    'count.passages.few': '{count}段摘录',
    'count.passages.many': '{count}段摘录',
    'count.passages.other': '{count}段摘录',
    'askAi.indexingPreparingAnnouncement': '正在为“询问 AI”准备您的会议。',
    'askAi.indexingPausedAnnouncement': '会议录制或笔记生成期间，“询问 AI”的准备工作暂停。',

    'askAi.indexingStarting':
      '正在为“询问 AI”准备您的会议。您现在就可以提问，但完成前回答可能遗漏一些细节。',
    'askAi.indexingProgress':
      '正在为“询问 AI”准备您的会议（{percent}%）。您现在就可以提问，但完成前回答可能遗漏一些细节。',
    'askAi.indexingPaused':
      '会议录制或笔记生成期间，“询问 AI”的准备工作暂停在{percent}%。之后会自动继续。在此之前，回答可能遗漏一些细节。',

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
    'askAi.coverage': '근거: {totalMeetings} 중 {meetings}개 회의에서 가져온 {passages}.',
    'count.passages.zero': '{count} 개 발췌문',
    'count.passages.one': '{count} 개 발췌문',
    'count.passages.two': '{count} 개 발췌문',
    'count.passages.few': '{count} 개 발췌문',
    'count.passages.many': '{count} 개 발췌문',
    'count.passages.other': '{count} 개 발췌문',
    'askAi.indexingPreparingAnnouncement': 'AI에게 묻기를 위해 회의를 준비하고 있습니다.',
    'askAi.indexingPausedAnnouncement':
      '회의를 녹음하거나 노트를 작성하는 동안 AI에게 묻기 준비가 일시 중지되었습니다.',

    'askAi.indexingStarting':
      'AI에게 묻기를 위해 회의를 준비하고 있습니다. 지금 질문할 수 있지만 완료될 때까지 답변에서 일부 세부 내용이 빠질 수 있습니다.',
    'askAi.indexingProgress':
      'AI에게 묻기를 위해 회의를 준비하고 있습니다({percent}%). 지금 질문할 수 있지만 완료될 때까지 답변에서 일부 세부 내용이 빠질 수 있습니다.',
    'askAi.indexingPaused':
      '회의를 녹음하거나 노트를 작성하는 동안 AI에게 묻기 준비가 {percent}%에서 일시 중지되었습니다. 이후 자동으로 계속됩니다. 그때까지 답변에서 일부 세부 내용이 빠질 수 있습니다.',

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
    'askAi.coverage':
      'Base de la réponse : {passages}. Réunions utilisées : {meetings} ; bibliothèque : {totalMeetings}.',
    'count.passages.zero': '{count} passages',
    'count.passages.one': '{count} passage',
    'count.passages.two': '{count} passages',
    'count.passages.few': '{count} passages',
    'count.passages.many': '{count} passages',
    'count.passages.other': '{count} passages',
    'askAi.indexingPreparingAnnouncement': 'Préparation de vos réunions pour Demander à l’IA.',
    'askAi.indexingPausedAnnouncement':
      'La préparation pour Demander à l’IA est en pause pendant l’enregistrement d’une réunion ou la création des notes.',

    'askAi.indexingStarting':
      'Préparation de vos réunions pour Demander à l’IA. Vous pouvez poser des questions, mais les réponses risquent de manquer de détails avant la fin.',
    'askAi.indexingProgress':
      'Préparation de vos réunions pour Demander à l’IA ({percent} %). Vous pouvez poser des questions, mais les réponses risquent de manquer de détails avant la fin.',
    'askAi.indexingPaused':
      'La préparation pour Demander à l’IA est en pause à {percent} % pendant l’enregistrement d’une réunion ou la création des notes. Elle reprendra automatiquement ensuite. D’ici là, des détails peuvent manquer dans les réponses.',

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
    'askAi.coverage':
      'Basado en {passages}. Reuniones utilizadas: {meetings}; en tu biblioteca: {totalMeetings}.',
    'count.passages.zero': '{count} fragmentos',
    'count.passages.one': '{count} fragmento',
    'count.passages.two': '{count} fragmentos',
    'count.passages.few': '{count} fragmentos',
    'count.passages.many': '{count} fragmentos',
    'count.passages.other': '{count} fragmentos',
    'askAi.indexingPreparingAnnouncement': 'Preparando tus reuniones para Preguntar a la IA.',
    'askAi.indexingPausedAnnouncement':
      'La preparación para Preguntar a la IA está pausada mientras se graba una reunión o se crean las notas.',

    'askAi.indexingStarting':
      'Preparando tus reuniones para Preguntar a la IA. Ya puedes preguntar, pero las respuestas pueden omitir detalles hasta que termine.',
    'askAi.indexingProgress':
      'Preparando tus reuniones para Preguntar a la IA ({percent}%). Ya puedes preguntar, pero las respuestas pueden omitir detalles hasta que termine.',
    'askAi.indexingPaused':
      'La preparación para Preguntar a la IA está pausada al {percent}% mientras se graba una reunión o se crean las notas. Continuará automáticamente después. Hasta entonces, las respuestas pueden omitir detalles.',

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
    'askAi.coverage':
      'Fonti: {passages}. Riunioni utilizzate: {meetings}; nella libreria: {totalMeetings}.',
    'count.passages.zero': '{count} passaggi',
    'count.passages.one': '{count} passaggio',
    'count.passages.two': '{count} passaggi',
    'count.passages.few': '{count} passaggi',
    'count.passages.many': '{count} passaggi',
    'count.passages.other': '{count} passaggi',
    'askAi.indexingPreparingAnnouncement': 'Preparazione delle riunioni per Chiedi all’IA.',
    'askAi.indexingPausedAnnouncement':
      'La preparazione per Chiedi all’IA è in pausa mentre si registra una riunione o si preparano le note.',

    'askAi.indexingStarting':
      'Preparazione delle riunioni per Chiedi all’IA. Puoi già fare domande, ma le risposte potrebbero omettere dettagli fino al termine.',
    'askAi.indexingProgress':
      'Preparazione delle riunioni per Chiedi all’IA ({percent}%). Puoi già fare domande, ma le risposte potrebbero omettere dettagli fino al termine.',
    'askAi.indexingPaused':
      'La preparazione per Chiedi all’IA è in pausa al {percent}% mentre si registra una riunione o si preparano le note. Riprenderà automaticamente dopo. Fino ad allora, le risposte potrebbero omettere dettagli.',

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
    'askAi.coverage':
      'Base da resposta: {passages}. Reuniões utilizadas: {meetings}; na biblioteca: {totalMeetings}.',
    'count.passages.zero': '{count} trechos',
    'count.passages.one': '{count} trecho',
    'count.passages.two': '{count} trechos',
    'count.passages.few': '{count} trechos',
    'count.passages.many': '{count} trechos',
    'count.passages.other': '{count} trechos',
    'askAi.indexingPreparingAnnouncement': 'A preparar as suas reuniões para Perguntar à IA.',
    'askAi.indexingPausedAnnouncement':
      'A preparação para Perguntar à IA está em pausa enquanto uma reunião é gravada ou as notas são criadas.',

    'askAi.indexingStarting':
      'A preparar as suas reuniões para Perguntar à IA. Já pode perguntar, mas as respostas podem omitir detalhes até à conclusão.',
    'askAi.indexingProgress':
      'A preparar as suas reuniões para Perguntar à IA ({percent}%). Já pode perguntar, mas as respostas podem omitir detalhes até à conclusão.',
    'askAi.indexingPaused':
      'A preparação para Perguntar à IA está em pausa nos {percent}% enquanto uma reunião é gravada ou as notas são criadas. Continuará automaticamente depois. Até lá, as respostas podem omitir detalhes.',

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
    'askAi.coverage':
      'Основа ответа: {passages}. Использовано встреч: {meetings}; в библиотеке: {totalMeetings}.',
    'count.passages.zero': '{count} отрывков',
    'count.passages.one': '{count} отрывок',
    'count.passages.two': '{count} отрывка',
    'count.passages.few': '{count} отрывка',
    'count.passages.many': '{count} отрывков',
    'count.passages.other': '{count} отрывка',
    'askAi.indexingPreparingAnnouncement': 'Подготовка встреч для функции «Спросить ИИ».',
    'askAi.indexingPausedAnnouncement':
      'Подготовка для «Спросить ИИ» приостановлена, пока записывается встреча или создаются заметки.',

    'askAi.indexingStarting':
      'Подготовка встреч для функции «Спросить ИИ». Уже можно задавать вопросы, но до завершения в ответах могут отсутствовать детали.',
    'askAi.indexingProgress':
      'Подготовка встреч для функции «Спросить ИИ» ({percent} %). Уже можно задавать вопросы, но до завершения в ответах могут отсутствовать детали.',
    'askAi.indexingPaused':
      'Подготовка для «Спросить ИИ» приостановлена на {percent} %, пока записывается встреча или создаются заметки. Затем она продолжится автоматически. До этого в ответах могут отсутствовать детали.',

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
    'askAi.coverage':
      'Основа відповіді: {passages}. Використано зустрічей: {meetings}; у бібліотеці: {totalMeetings}.',
    'count.passages.zero': '{count} уривків',
    'count.passages.one': '{count} уривок',
    'count.passages.two': '{count} уривки',
    'count.passages.few': '{count} уривки',
    'count.passages.many': '{count} уривків',
    'count.passages.other': '{count} уривка',
    'askAi.indexingPreparingAnnouncement': 'Підготовка зустрічей для функції «Запитати ШІ».',
    'askAi.indexingPausedAnnouncement':
      'Підготовку для «Запитати ШІ» призупинено, поки записується зустріч або створюються нотатки.',

    'askAi.indexingStarting':
      'Підготовка зустрічей для функції «Запитати ШІ». Уже можна ставити запитання, але до завершення у відповідях можуть бути відсутні деталі.',
    'askAi.indexingProgress':
      'Підготовка зустрічей для функції «Запитати ШІ» ({percent} %). Уже можна ставити запитання, але до завершення у відповідях можуть бути відсутні деталі.',
    'askAi.indexingPaused':
      'Підготовку для «Запитати ШІ» призупинено на {percent} %, поки записується зустріч або створюються нотатки. Потім вона продовжиться автоматично. Доти у відповідях можуть бути відсутні деталі.',

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
    'askAi.coverage':
      'Основа на отговора: {passages}. Използвани срещи: {meetings}; в библиотеката: {totalMeetings}.',
    'count.passages.zero': '{count} откъса',
    'count.passages.one': '{count} откъс',
    'count.passages.two': '{count} откъса',
    'count.passages.few': '{count} откъса',
    'count.passages.many': '{count} откъса',
    'count.passages.other': '{count} откъса',
    'askAi.indexingPreparingAnnouncement': 'Подготовка на срещите ви за „Попитай ИИ“.',
    'askAi.indexingPausedAnnouncement':
      'Подготовката за „Попитай ИИ“ е спряна, докато се записва среща или се създават бележки.',

    'askAi.indexingStarting':
      'Подготовка на срещите ви за „Попитай ИИ“. Можете да питате сега, но до завършването в отговорите може да липсват подробности.',
    'askAi.indexingProgress':
      'Подготовка на срещите ви за „Попитай ИИ“ ({percent} %). Можете да питате сега, но до завършването в отговорите може да липсват подробности.',
    'askAi.indexingPaused':
      'Подготовката за „Попитай ИИ“ е спряна на {percent} %, докато се записва среща или се създават бележки. След това ще продължи автоматично. Дотогава в отговорите може да липсват подробности.',

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
    'askAi.coverage':
      'Osnova odgovora: {passages}. Korišteni sastanci: {meetings}; u biblioteci: {totalMeetings}.',
    'count.passages.zero': '{count} odlomaka',
    'count.passages.one': '{count} odlomak',
    'count.passages.two': '{count} odlomka',
    'count.passages.few': '{count} odlomka',
    'count.passages.many': '{count} odlomaka',
    'count.passages.other': '{count} odlomaka',
    'askAi.indexingPreparingAnnouncement': 'Priprema sastanaka za Pitaj AI.',
    'askAi.indexingPausedAnnouncement':
      'Priprema za Pitaj AI pauzirana je dok se snima sastanak ili izrađuju bilješke.',

    'askAi.indexingStarting':
      'Priprema sastanaka za Pitaj AI. Već možete pitati, ali do završetka u odgovorima mogu nedostajati pojedinosti.',
    'askAi.indexingProgress':
      'Priprema sastanaka za Pitaj AI ({percent} %). Već možete pitati, ali do završetka u odgovorima mogu nedostajati pojedinosti.',
    'askAi.indexingPaused':
      'Priprema za Pitaj AI pauzirana je na {percent} % dok se snima sastanak ili izrađuju bilješke. Nakon toga nastavlja se automatski. Dotad u odgovorima mogu nedostajati pojedinosti.',

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
    'askAi.coverage':
      'Podklad odpovědi: {passages}. Využité schůzky: {meetings}; v knihovně: {totalMeetings}.',
    'count.passages.zero': '{count} úryvků',
    'count.passages.one': '{count} úryvek',
    'count.passages.two': '{count} úryvky',
    'count.passages.few': '{count} úryvky',
    'count.passages.many': '{count} úryvku',
    'count.passages.other': '{count} úryvků',
    'askAi.indexingPreparingAnnouncement': 'Příprava vašich schůzek pro Zeptat se AI.',
    'askAi.indexingPausedAnnouncement':
      'Příprava pro Zeptat se AI je pozastavena, zatímco se nahrává schůzka nebo vytvářejí poznámky.',

    'askAi.indexingStarting':
      'Příprava vašich schůzek pro Zeptat se AI. Ptát se můžete už teď, ale do dokončení mohou v odpovědích chybět podrobnosti.',
    'askAi.indexingProgress':
      'Příprava vašich schůzek pro Zeptat se AI ({percent} %). Ptát se můžete už teď, ale do dokončení mohou v odpovědích chybět podrobnosti.',
    'askAi.indexingPaused':
      'Příprava pro Zeptat se AI je pozastavena na {percent} %, zatímco se nahrává schůzka nebo vytvářejí poznámky. Poté bude automaticky pokračovat. Do té doby mohou v odpovědích chybět podrobnosti.',

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
    'askAi.coverage': 'Baseret på {passages} fra {meetings} ud af i alt {totalMeetings}.',
    'count.passages.zero': '{count} uddrag',
    'count.passages.one': '{count} uddrag',
    'count.passages.two': '{count} uddrag',
    'count.passages.few': '{count} uddrag',
    'count.passages.many': '{count} uddrag',
    'count.passages.other': '{count} uddrag',
    'askAi.indexingPreparingAnnouncement': 'Dine møder gøres klar til Spørg AI.',
    'askAi.indexingPausedAnnouncement':
      'Klargøring til Spørg AI er sat på pause, mens et møde optages, eller noter bliver lavet.',

    'askAi.indexingStarting':
      'Dine møder gøres klar til Spørg AI. Du kan spørge nu, men svarene kan mangle detaljer, indtil det er færdigt.',
    'askAi.indexingProgress':
      'Dine møder gøres klar til Spørg AI ({percent} %). Du kan spørge nu, men svarene kan mangle detaljer, indtil det er færdigt.',
    'askAi.indexingPaused':
      'Klargøring til Spørg AI er sat på pause ved {percent} %, mens et møde optages, eller noter bliver lavet. Den fortsætter automatisk bagefter. Indtil da kan svarene mangle detaljer.',

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
    'askAi.coverage': 'Gebaseerd op {passages} uit {meetings} van in totaal {totalMeetings}.',
    'count.passages.zero': '{count} fragmenten',
    'count.passages.one': '{count} fragment',
    'count.passages.two': '{count} fragmenten',
    'count.passages.few': '{count} fragmenten',
    'count.passages.many': '{count} fragmenten',
    'count.passages.other': '{count} fragmenten',
    'askAi.indexingPreparingAnnouncement': 'Je vergaderingen worden voorbereid voor Vraag AI.',
    'askAi.indexingPausedAnnouncement':
      'De voorbereiding voor Vraag AI is gepauzeerd terwijl een vergadering wordt opgenomen of notities worden gemaakt.',

    'askAi.indexingStarting':
      'Je vergaderingen worden voorbereid voor Vraag AI. Je kunt al vragen stellen, maar tot dit klaar is kunnen antwoorden details missen.',
    'askAi.indexingProgress':
      'Je vergaderingen worden voorbereid voor Vraag AI ({percent}%). Je kunt al vragen stellen, maar tot dit klaar is kunnen antwoorden details missen.',
    'askAi.indexingPaused':
      'De voorbereiding voor Vraag AI is gepauzeerd op {percent}% terwijl een vergadering wordt opgenomen of notities worden gemaakt. Daarna gaat dit automatisch verder. Tot die tijd kunnen antwoorden details missen.',

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
    'askAi.coverage':
      'Vastuse aluseks: {passages}. Kasutatud koosolekuid: {meetings}; teegis: {totalMeetings}.',
    'count.passages.zero': '{count} katkendit',
    'count.passages.one': '{count} katkend',
    'count.passages.two': '{count} katkendit',
    'count.passages.few': '{count} katkendit',
    'count.passages.many': '{count} katkendit',
    'count.passages.other': '{count} katkendit',
    'askAi.indexingPreparingAnnouncement': 'Koosolekuid valmistatakse ette tehisarult küsimiseks.',
    'askAi.indexingPausedAnnouncement':
      'Koosolekute ettevalmistus tehisarult küsimiseks on peatatud, kuni koosolekut salvestatakse või märkmeid koostatakse.',

    'askAi.indexingStarting':
      'Koosolekuid valmistatakse ette tehisarult küsimiseks. Võid juba küsida, kuid kuni valmimiseni võib vastustest üksikasju puududa.',
    'askAi.indexingProgress':
      'Koosolekuid valmistatakse ette tehisarult küsimiseks ({percent} %). Võid juba küsida, kuid kuni valmimiseni võib vastustest üksikasju puududa.',
    'askAi.indexingPaused':
      'Koosolekute ettevalmistus tehisarult küsimiseks on peatatud {percent} % juures, kuni koosolekut salvestatakse või märkmeid koostatakse. Seejärel jätkub see automaatselt. Seni võib vastustest üksikasju puududa.',

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
    'askAi.coverage':
      'Vastauksen pohjana: {passages}. Käytetyt kokoukset: {meetings}; kirjastossa: {totalMeetings}.',
    'count.passages.zero': '{count} katkelmaa',
    'count.passages.one': '{count} katkelma',
    'count.passages.two': '{count} katkelmaa',
    'count.passages.few': '{count} katkelmaa',
    'count.passages.many': '{count} katkelmaa',
    'count.passages.other': '{count} katkelmaa',
    'askAi.indexingPreparingAnnouncement': 'Kokouksiasi valmistellaan tekoälyltä kysymistä varten.',
    'askAi.indexingPausedAnnouncement':
      'Kokousten valmistelu tekoälyltä kysymistä varten on tauolla, kun kokousta tallennetaan tai muistiinpanoja luodaan.',

    'askAi.indexingStarting':
      'Kokouksiasi valmistellaan tekoälyltä kysymistä varten. Voit jo kysyä, mutta vastauksista voi puuttua tietoja, kunnes valmistelu päättyy.',
    'askAi.indexingProgress':
      'Kokouksiasi valmistellaan tekoälyltä kysymistä varten ({percent} %). Voit jo kysyä, mutta vastauksista voi puuttua tietoja, kunnes valmistelu päättyy.',
    'askAi.indexingPaused':
      'Kokousten valmistelu tekoälyltä kysymistä varten on tauolla kohdassa {percent} %, kun kokousta tallennetaan tai muistiinpanoja luodaan. Se jatkuu sitten automaattisesti. Siihen asti vastauksista voi puuttua tietoja.',

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
    'askAi.coverage':
      'Βάση απάντησης: {passages}. Συναντήσεις που χρησιμοποιήθηκαν: {meetings}· στη βιβλιοθήκη: {totalMeetings}.',
    'count.passages.zero': '{count} αποσπάσματα',
    'count.passages.one': '{count} απόσπασμα',
    'count.passages.two': '{count} αποσπάσματα',
    'count.passages.few': '{count} αποσπάσματα',
    'count.passages.many': '{count} αποσπάσματα',
    'count.passages.other': '{count} αποσπάσματα',
    'askAi.indexingPreparingAnnouncement': 'Προετοιμασία των συσκέψεών σας για το Ρωτήστε το AI.',
    'askAi.indexingPausedAnnouncement':
      'Η προετοιμασία για το Ρωτήστε το AI έχει παύσει όσο γίνεται εγγραφή σύσκεψης ή δημιουργούνται σημειώσεις.',

    'askAi.indexingStarting':
      'Προετοιμασία των συσκέψεών σας για το Ρωτήστε το AI. Μπορείτε να ρωτήσετε τώρα, αλλά ως την ολοκλήρωση ίσως λείπουν λεπτομέρειες από τις απαντήσεις.',
    'askAi.indexingProgress':
      'Προετοιμασία των συσκέψεών σας για το Ρωτήστε το AI ({percent}%). Μπορείτε να ρωτήσετε τώρα, αλλά ως την ολοκλήρωση ίσως λείπουν λεπτομέρειες από τις απαντήσεις.',
    'askAi.indexingPaused':
      'Η προετοιμασία για το Ρωτήστε το AI έχει παύσει στο {percent}% όσο γίνεται εγγραφή σύσκεψης ή δημιουργούνται σημειώσεις. Θα συνεχιστεί αυτόματα μετά. Ως τότε ίσως λείπουν λεπτομέρειες από τις απαντήσεις.',

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
    'askAi.coverage':
      'A válasz alapja: {passages}. Felhasznált megbeszélések: {meetings}; a könyvtárban: {totalMeetings}.',
    'count.passages.zero': '{count} részlet',
    'count.passages.one': '{count} részlet',
    'count.passages.two': '{count} részlet',
    'count.passages.few': '{count} részlet',
    'count.passages.many': '{count} részlet',
    'count.passages.other': '{count} részlet',
    'askAi.indexingPreparingAnnouncement':
      'Az értekezletek előkészítése a Kérdezd az AI-t funkcióhoz.',
    'askAi.indexingPausedAnnouncement':
      'A Kérdezd az AI-t előkészítése szünetel, amíg értekezletet rögzít vagy jegyzetek készülnek.',

    'askAi.indexingStarting':
      'Az értekezletek előkészítése a Kérdezd az AI-t funkcióhoz. Már kérdezhet, de a befejezésig a válaszokból részletek hiányozhatnak.',
    'askAi.indexingProgress':
      'Az értekezletek előkészítése a Kérdezd az AI-t funkcióhoz ({percent}%). Már kérdezhet, de a befejezésig a válaszokból részletek hiányozhatnak.',
    'askAi.indexingPaused':
      'A Kérdezd az AI-t előkészítése {percent}%-nál szünetel, amíg értekezletet rögzít vagy jegyzetek készülnek. Utána automatikusan folytatódik. Addig a válaszokból részletek hiányozhatnak.',

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
    'askAi.coverage':
      'Atbildes pamats: {passages}. Izmantotās sapulces: {meetings}; bibliotēkā: {totalMeetings}.',
    'count.passages.zero': '{count} fragmentu',
    'count.passages.one': '{count} fragments',
    'count.passages.two': '{count} fragmenti',
    'count.passages.few': '{count} fragmenti',
    'count.passages.many': '{count} fragmentu',
    'count.passages.other': '{count} fragmenti',
    'askAi.indexingPreparingAnnouncement': 'Sanāksmju sagatavošana funkcijai Jautāt AI.',
    'askAi.indexingPausedAnnouncement':
      'Sagatavošana funkcijai Jautāt AI ir apturēta, kamēr tiek ierakstīta sanāksme vai veidotas piezīmes.',

    'askAi.indexingStarting':
      'Sanāksmju sagatavošana funkcijai Jautāt AI. Varat jautāt jau tagad, bet līdz beigām atbildēs var trūkt detaļu.',
    'askAi.indexingProgress':
      'Sanāksmju sagatavošana funkcijai Jautāt AI ({percent} %). Varat jautāt jau tagad, bet līdz beigām atbildēs var trūkt detaļu.',
    'askAi.indexingPaused':
      'Sagatavošana funkcijai Jautāt AI ir apturēta pie {percent} %, kamēr tiek ierakstīta sanāksme vai veidotas piezīmes. Pēc tam tā turpināsies automātiski. Līdz tam atbildēs var trūkt detaļu.',

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
    'askAi.coverage':
      'Atsakymo pagrindas: {passages}. Panaudoti susitikimai: {meetings}; bibliotekoje: {totalMeetings}.',
    'count.passages.zero': '{count} ištraukų',
    'count.passages.one': '{count} ištrauka',
    'count.passages.two': '{count} ištraukos',
    'count.passages.few': '{count} ištraukos',
    'count.passages.many': '{count} ištraukos',
    'count.passages.other': '{count} ištraukų',
    'askAi.indexingPreparingAnnouncement': 'Susitikimų paruošimas funkcijai Klausti DI.',
    'askAi.indexingPausedAnnouncement':
      'Paruošimas funkcijai Klausti DI sustabdytas, kol įrašomas susitikimas arba rengiamos pastabos.',

    'askAi.indexingStarting':
      'Susitikimų paruošimas funkcijai Klausti DI. Jau galite klausti, bet iki pabaigos atsakymuose gali trūkti detalių.',
    'askAi.indexingProgress':
      'Susitikimų paruošimas funkcijai Klausti DI ({percent} %). Jau galite klausti, bet iki pabaigos atsakymuose gali trūkti detalių.',
    'askAi.indexingPaused':
      'Paruošimas funkcijai Klausti DI sustabdytas ties {percent} %, kol įrašomas susitikimas arba rengiamos pastabos. Vėliau jis tęsis automatiškai. Iki tol atsakymuose gali trūkti detalių.',

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
    'askAi.coverage':
      'Podstawa odpowiedzi: {passages}. Wykorzystane spotkania: {meetings}; w bibliotece: {totalMeetings}.',
    'count.passages.zero': '{count} fragmentów',
    'count.passages.one': '{count} fragment',
    'count.passages.two': '{count} fragmenty',
    'count.passages.few': '{count} fragmenty',
    'count.passages.many': '{count} fragmentów',
    'count.passages.other': '{count} fragmentu',
    'askAi.indexingPreparingAnnouncement': 'Przygotowywanie spotkań do funkcji Zapytaj AI.',
    'askAi.indexingPausedAnnouncement':
      'Przygotowywanie do Zapytaj AI wstrzymano, gdy trwa nagrywanie spotkania lub tworzenie notatek.',

    'askAi.indexingStarting':
      'Przygotowywanie spotkań do funkcji Zapytaj AI. Możesz już pytać, ale do zakończenia w odpowiedziach może brakować szczegółów.',
    'askAi.indexingProgress':
      'Przygotowywanie spotkań do funkcji Zapytaj AI ({percent}%). Możesz już pytać, ale do zakończenia w odpowiedziach może brakować szczegółów.',
    'askAi.indexingPaused':
      'Przygotowywanie do Zapytaj AI wstrzymano przy {percent}%, gdy trwa nagrywanie spotkania lub tworzenie notatek. Później zostanie wznowione automatycznie. Do tego czasu w odpowiedziach może brakować szczegółów.',

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
    'askAi.coverage':
      'Baza răspunsului: {passages}. Întâlniri folosite: {meetings}; în bibliotecă: {totalMeetings}.',
    'count.passages.zero': '{count} fragmente',
    'count.passages.one': '{count} fragment',
    'count.passages.two': '{count} fragmente',
    'count.passages.few': '{count} fragmente',
    'count.passages.many': '{count} fragmente',
    'count.passages.other': '{count} fragmente',
    'askAi.indexingPreparingAnnouncement': 'Pregătirea întâlnirilor pentru Întreabă AI.',
    'askAi.indexingPausedAnnouncement':
      'Pregătirea pentru Întreabă AI este în pauză cât timp se înregistrează o întâlnire sau se creează notițe.',

    'askAi.indexingStarting':
      'Pregătirea întâlnirilor pentru Întreabă AI. Puteți întreba acum, dar până la final răspunsurile pot omite detalii.',
    'askAi.indexingProgress':
      'Pregătirea întâlnirilor pentru Întreabă AI ({percent}%). Puteți întreba acum, dar până la final răspunsurile pot omite detalii.',
    'askAi.indexingPaused':
      'Pregătirea pentru Întreabă AI este în pauză la {percent}% cât timp se înregistrează o întâlnire sau se creează notițe. Va continua automat după aceea. Până atunci, răspunsurile pot omite detalii.',

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
    'askAi.coverage':
      'Podklad odpovede: {passages}. Použité stretnutia: {meetings}; v knižnici: {totalMeetings}.',
    'count.passages.zero': '{count} úryvkov',
    'count.passages.one': '{count} úryvok',
    'count.passages.two': '{count} úryvky',
    'count.passages.few': '{count} úryvky',
    'count.passages.many': '{count} úryvku',
    'count.passages.other': '{count} úryvkov',
    'askAi.indexingPreparingAnnouncement': 'Príprava vašich schôdzí pre Opýtať sa AI.',
    'askAi.indexingPausedAnnouncement':
      'Príprava pre Opýtať sa AI je pozastavená, kým sa nahráva schôdza alebo vytvárajú poznámky.',

    'askAi.indexingStarting':
      'Príprava vašich schôdzí pre Opýtať sa AI. Pýtať sa môžete už teraz, ale do dokončenia môžu v odpovediach chýbať podrobnosti.',
    'askAi.indexingProgress':
      'Príprava vašich schôdzí pre Opýtať sa AI ({percent} %). Pýtať sa môžete už teraz, ale do dokončenia môžu v odpovediach chýbať podrobnosti.',
    'askAi.indexingPaused':
      'Príprava pre Opýtať sa AI je pozastavená na {percent} %, kým sa nahráva schôdza alebo vytvárajú poznámky. Potom bude automaticky pokračovať. Dovtedy môžu v odpovediach chýbať podrobnosti.',

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
    'askAi.coverage':
      'Podlaga odgovora: {passages}. Uporabljeni sestanki: {meetings}; v knjižnici: {totalMeetings}.',
    'count.passages.zero': '{count} odlomkov',
    'count.passages.one': '{count} odlomek',
    'count.passages.two': '{count} odlomka',
    'count.passages.few': '{count} odlomki',
    'count.passages.many': '{count} odlomkov',
    'count.passages.other': '{count} odlomkov',
    'askAi.indexingPreparingAnnouncement': 'Priprava sestankov za Vprašaj AI.',
    'askAi.indexingPausedAnnouncement':
      'Priprava za Vprašaj AI je ustavljena, medtem ko se snema sestanek ali ustvarjajo zapiski.',

    'askAi.indexingStarting':
      'Priprava sestankov za Vprašaj AI. Vprašate lahko že zdaj, vendar lahko do zaključka v odgovorih manjkajo podrobnosti.',
    'askAi.indexingProgress':
      'Priprava sestankov za Vprašaj AI ({percent} %). Vprašate lahko že zdaj, vendar lahko do zaključka v odgovorih manjkajo podrobnosti.',
    'askAi.indexingPaused':
      'Priprava za Vprašaj AI je ustavljena pri {percent} %, medtem ko se snema sestanek ali ustvarjajo zapiski. Nato se bo samodejno nadaljevala. Do takrat lahko v odgovorih manjkajo podrobnosti.',

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
    'askAi.coverage': 'Baserat på {passages} från {meetings} av totalt {totalMeetings}.',
    'count.passages.zero': '{count} utdrag',
    'count.passages.one': '{count} utdrag',
    'count.passages.two': '{count} utdrag',
    'count.passages.few': '{count} utdrag',
    'count.passages.many': '{count} utdrag',
    'count.passages.other': '{count} utdrag',
    'askAi.indexingPreparingAnnouncement': 'Dina möten förbereds för Fråga AI.',
    'askAi.indexingPausedAnnouncement':
      'Förberedelsen för Fråga AI är pausad medan ett möte spelas in eller anteckningar skapas.',

    'askAi.indexingStarting':
      'Dina möten förbereds för Fråga AI. Du kan fråga nu, men svaren kan sakna detaljer tills förberedelsen är klar.',
    'askAi.indexingProgress':
      'Dina möten förbereds för Fråga AI ({percent} %). Du kan fråga nu, men svaren kan sakna detaljer tills förberedelsen är klar.',
    'askAi.indexingPaused':
      'Förberedelsen för Fråga AI är pausad vid {percent} % medan ett möte spelas in eller anteckningar skapas. Den fortsätter automatiskt efteråt. Tills dess kan svaren sakna detaljer.',

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
