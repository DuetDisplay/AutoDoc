import type { UiLanguageCode } from '../../ui-language'
import type { MessageCatalog } from './en'

type LeftoverOverlay = Partial<MessageCatalog>

export const leftoverOverlays: Partial<Record<UiLanguageCode, LeftoverOverlay>> = {
  ko: {
    'meeting.reprocessTranscriptHint': '오디오를 다시 받아쓰고 새 텍스트에서 노트를 재생성합니다',
    'meeting.reprocessNotesHint': '기존 텍스트에서 AI 노트를 재생성합니다',
    'meeting.reprocess': '재처리',
    'meeting.queued': '대기 중...',
    'meeting.dangerZone': '위험 영역',
    'meeting.cannotUndo': '이 작업은 취소할 수 없습니다.',
    'meeting.deleteRecording': '녹음 삭제',
    'meeting.deleteRecordingHint': '모든 오디오, 동영상, 대화 기록, 노트를 영구적으로 제거합니다',
    'meeting.confirmDelete': '삭제 확인'
  },
  ja: {
    'meeting.reprocessTranscriptHint': 'オーディオを文字起こしし直し、新しい文字起こしからノートを再生成します',
    'meeting.reprocessNotesHint': '既存の文字起こしからAIノートを再生成します',
    'meeting.reprocess': '再処理',
    'meeting.queued': '待機中...',
    'meeting.dangerZone': '危険ゾーン',
    'meeting.cannotUndo': 'この操作は元に戻せません。',
    'meeting.deleteRecording': '録音を削除',
    'meeting.deleteRecordingHint': 'すべてのオーディオ、動画、文字起こし、ノートを完全に削除します',
    'meeting.confirmDelete': '削除を確認'
  },
  'zh-Hans': {
    'meeting.reprocessTranscriptHint': '重新转录音频并从新转录稿生成笔记',
    'meeting.reprocessNotesHint': '从现有转录稿重新生成 AI 笔记',
    'meeting.reprocess': '重新处理',
    'meeting.queued': '排队中...',
    'meeting.dangerZone': '危险区域',
    'meeting.cannotUndo': '此操作无法撤销。',
    'meeting.deleteRecording': '删除录音',
    'meeting.deleteRecordingHint': '永久删除所有音频、视频、转录稿和笔记',
    'meeting.confirmDelete': '确认删除'
  },
  de: {
    'meeting.reprocessTranscriptHint':
      'Audio neu transkribieren und Notizen aus dem neuen Transkript erstellen',
    'meeting.reprocessNotesHint': 'KI-Notizen aus dem bestehenden Transkript neu erstellen',
    'meeting.reprocess': 'Neu verarbeiten',
    'meeting.queued': 'In der Warteschlange...',
    'meeting.dangerZone': 'Gefahrenzone',
    'meeting.cannotUndo': 'Diese Aktion kann nicht rückgängig gemacht werden.',
    'meeting.deleteRecording': 'Aufnahme löschen',
    'meeting.deleteRecordingHint':
      'Alle Audio-, Video-, Transkript- und Notizdateien dauerhaft entfernen',
    'meeting.confirmDelete': 'Löschen bestätigen'
  },
  fr: {
    'meeting.reprocessTranscriptHint':
      'Retranscrire l\u2019audio et régénérer les notes depuis la nouvelle transcription',
    'meeting.reprocessNotesHint':
      'Régénérer les notes IA depuis la transcription existante',
    'meeting.reprocess': 'Retraiter',
    'meeting.queued': 'En attente...',
    'meeting.dangerZone': 'Zone dangereuse',
    'meeting.cannotUndo': 'Cette action est irréversible.',
    'meeting.deleteRecording': 'Supprimer l\u2019enregistrement',
    'meeting.deleteRecordingHint':
      'Supprimer définitivement tout l\u2019audio, la vidéo, la transcription et les notes',
    'meeting.confirmDelete': 'Confirmer la suppression'
  },
  es: {
    'meeting.reprocessTranscriptHint':
      'Volver a transcribir el audio y regenerar las notas a partir de la nueva transcripción',
    'meeting.reprocessNotesHint':
      'Regenerar las notas de IA a partir de la transcripción existente',
    'meeting.reprocess': 'Reprocesar',
    'meeting.queued': 'En cola...',
    'meeting.dangerZone': 'Zona peligrosa',
    'meeting.cannotUndo': 'Esta acción no se puede deshacer.',
    'meeting.deleteRecording': 'Eliminar grabación',
    'meeting.deleteRecordingHint':
      'Eliminar permanentemente todo el audio, vídeo, transcripción y notas',
    'meeting.confirmDelete': 'Confirmar eliminación'
  },
  it: {
    'meeting.reprocessTranscriptHint':
      'Ritrascrivere l\u2019audio e rigenerare le note dalla nuova trascrizione',
    'meeting.reprocessNotesHint': 'Rigenerare le note IA dalla trascrizione esistente',
    'meeting.reprocess': 'Rielabora',
    'meeting.queued': 'In coda...',
    'meeting.dangerZone': 'Zona pericolosa',
    'meeting.cannotUndo': 'Questa azione non può essere annullata.',
    'meeting.deleteRecording': 'Elimina registrazione',
    'meeting.deleteRecordingHint': 'Rimuovi definitivamente audio, video, trascrizione e note',
    'meeting.confirmDelete': 'Conferma eliminazione'
  },
  pt: {
    'meeting.reprocessTranscriptHint':
      'Transcrever novamente o áudio e regenerar notas a partir da nova transcrição',
    'meeting.reprocessNotesHint': 'Regenerar notas de IA a partir da transcrição existente',
    'meeting.reprocess': 'Reprocessar',
    'meeting.queued': 'Na fila...',
    'meeting.dangerZone': 'Zona de perigo',
    'meeting.cannotUndo': 'Esta ação não pode ser desfeita.',
    'meeting.deleteRecording': 'Eliminar gravação',
    'meeting.deleteRecordingHint':
      'Remover permanentemente todo o áudio, vídeo, transcrição e notas',
    'meeting.confirmDelete': 'Confirmar eliminação'
  },
  nl: {
    'meeting.reprocessTranscriptHint':
      'Audio opnieuw transcriberen en notities opnieuw genereren vanuit het nieuwe transcript',
    'meeting.reprocessNotesHint':
      'AI-notities opnieuw genereren vanuit het bestaande transcript',
    'meeting.reprocess': 'Opnieuw verwerken',
    'meeting.queued': 'In wachtrij...',
    'meeting.dangerZone': 'Gevarenzone',
    'meeting.cannotUndo': 'Deze actie kan niet ongedaan worden gemaakt.',
    'meeting.deleteRecording': 'Opname verwijderen',
    'meeting.deleteRecordingHint':
      'Alle audio, video, transcript en notities permanent verwijderen',
    'meeting.confirmDelete': 'Verwijdering bevestigen'
  },
  sv: {
    'meeting.reprocessTranscriptHint':
      'Transkribera om ljudet och generera om anteckningar från den nya transkriptionen',
    'meeting.reprocessNotesHint':
      'Generera om AI-anteckningar från den befintliga transkriptionen',
    'meeting.reprocess': 'Bearbeta om',
    'meeting.queued': 'I kö...',
    'meeting.dangerZone': 'Farozon',
    'meeting.cannotUndo': 'Den här åtgärden kan inte ångras.',
    'meeting.deleteRecording': 'Radera inspelning',
    'meeting.deleteRecordingHint':
      'Ta bort allt ljud, video, transkription och anteckningar permanent',
    'meeting.confirmDelete': 'Bekräfta radering'
  },
  da: {
    'meeting.reprocessTranscriptHint':
      'Transskribér lyden igen og regenerér noter fra den nye transskription',
    'meeting.reprocessNotesHint': 'Regenerér AI-noter fra den eksisterende transskription',
    'meeting.reprocess': 'Genbehandl',
    'meeting.queued': 'I kø...',
    'meeting.dangerZone': 'Farezonen',
    'meeting.cannotUndo': 'Denne handling kan ikke fortrydes.',
    'meeting.deleteRecording': 'Slet optagelse',
    'meeting.deleteRecordingHint':
      'Fjern al lyd, video, transskription og noter permanent',
    'meeting.confirmDelete': 'Bekræft sletning'
  },
  fi: {
    'meeting.reprocessTranscriptHint':
      'Litteroi ääni uudelleen ja luo muistiinpanot uudesta litteroinnista',
    'meeting.reprocessNotesHint':
      'Luo AI-muistiinpanot uudelleen olemassa olevasta litteroinnista',
    'meeting.reprocess': 'Käsittele uudelleen',
    'meeting.queued': 'Jonossa...',
    'meeting.dangerZone': 'Vaaravyöhyke',
    'meeting.cannotUndo': 'Tätä toimintoa ei voi kumota.',
    'meeting.deleteRecording': 'Poista nauhoitus',
    'meeting.deleteRecordingHint':
      'Poista pysyvästi kaikki ääni, video, litterointi ja muistiinpanot',
    'meeting.confirmDelete': 'Vahvista poistaminen'
  },
  pl: {
    'meeting.reprocessTranscriptHint':
      'Ponownie transkrybuj dźwięk i generuj notatki na podstawie nowej transkrypcji',
    'meeting.reprocessNotesHint':
      'Wygeneruj ponownie notatki AI na podstawie istniejącej transkrypcji',
    'meeting.reprocess': 'Przetwórz ponownie',
    'meeting.queued': 'W kolejce...',
    'meeting.dangerZone': 'Strefa niebezpieczna',
    'meeting.cannotUndo': 'Tej akcji nie można cofnąć.',
    'meeting.deleteRecording': 'Usuń nagranie',
    'meeting.deleteRecordingHint':
      'Trwale usuń wszystkie pliki audio, wideo, transkrypcję i notatki',
    'meeting.confirmDelete': 'Potwierdź usunięcie'
  },
  ru: {
    'meeting.reprocessTranscriptHint':
      'Повторно транскрибировать аудио и создать заметки из нового транскрипта',
    'meeting.reprocessNotesHint':
      'Повторно создать заметки ИИ из существующего транскрипта',
    'meeting.reprocess': 'Переработать',
    'meeting.queued': 'В очереди...',
    'meeting.dangerZone': 'Опасная зона',
    'meeting.cannotUndo': 'Это действие невозможно отменить.',
    'meeting.deleteRecording': 'Удалить запись',
    'meeting.deleteRecordingHint':
      'Безвозвратно удалить всё аудио, видео, транскрипт и заметки',
    'meeting.confirmDelete': 'Подтвердить удаление'
  },
  uk: {
    'meeting.reprocessTranscriptHint':
      'Перетранскрибувати аудіо і відновити нотатки з нового транскрипту',
    'meeting.reprocessNotesHint': 'Відновити нотатки ШІ з існуючого транскрипту',
    'meeting.reprocess': 'Переопрацювати',
    'meeting.queued': 'У черзі...',
    'meeting.dangerZone': 'Небезпечна зона',
    'meeting.cannotUndo': 'Цю дію не можна скасувати.',
    'meeting.deleteRecording': 'Видалити запис',
    'meeting.deleteRecordingHint':
      'Назавжди видалити всі аудіо, відео, транскрипт і нотатки',
    'meeting.confirmDelete': 'Підтвердити видалення'
  },
  cs: {
    'meeting.reprocessTranscriptHint':
      'Přepsat znovu audio a regenerovat poznámky z nového přepisu',
    'meeting.reprocessNotesHint': 'Regenerovat poznámky AI ze stávajícího přepisu',
    'meeting.reprocess': 'Znovu zpracovat',
    'meeting.queued': 'Ve frontě...',
    'meeting.dangerZone': 'Nebezpečná zóna',
    'meeting.cannotUndo': 'Tuto akci nelze vrátit.',
    'meeting.deleteRecording': 'Smazat nahrávku',
    'meeting.deleteRecordingHint':
      'Trvale odstranit veškeré audio, video, přepis a poznámky',
    'meeting.confirmDelete': 'Potvrdit smazání'
  },
  sk: {
    'meeting.reprocessTranscriptHint':
      'Znovu prepísať zvuk a regenerovať poznámky z nového prepisu',
    'meeting.reprocessNotesHint': 'Regenerovať poznámky AI z existujúceho prepisu',
    'meeting.reprocess': 'Znovu spracovať',
    'meeting.queued': 'V poradí...',
    'meeting.dangerZone': 'Nebezpečná zóna',
    'meeting.cannotUndo': 'Túto akciu nie je možné vrátiť späť.',
    'meeting.deleteRecording': 'Vymazať nahrávku',
    'meeting.deleteRecordingHint':
      'Trvalo odstrániť všetky zvuky, video, prepis a poznámky',
    'meeting.confirmDelete': 'Potvrdiť vymazanie'
  },
  sl: {
    'meeting.reprocessTranscriptHint':
      'Znova prepiši zvok in ustvari zapiske iz novega prepisa',
    'meeting.reprocessNotesHint': 'Znova ustvari zapiske AI iz obstoječega prepisa',
    'meeting.reprocess': 'Znova obdelaj',
    'meeting.queued': 'V čakalni vrsti...',
    'meeting.dangerZone': 'Nevarno območje',
    'meeting.cannotUndo': 'Tega dejanja ni mogoče razveljaviti.',
    'meeting.deleteRecording': 'Izbriši posnetek',
    'meeting.deleteRecordingHint':
      'Trajno odstrani ves zvok, video, prepis in zapiske',
    'meeting.confirmDelete': 'Potrdi brisanje'
  },
  hr: {
    'meeting.reprocessTranscriptHint':
      'Ponovo transkribiraj zvuk i regeneriraj bilješke iz novog transkripta',
    'meeting.reprocessNotesHint': 'Regeneriraj AI bilješke iz postojećeg transkripta',
    'meeting.reprocess': 'Obradi ponovo',
    'meeting.queued': 'U redu čekanja...',
    'meeting.dangerZone': 'Opasna zona',
    'meeting.cannotUndo': 'Ova radnja se ne može poništiti.',
    'meeting.deleteRecording': 'Obriši snimku',
    'meeting.deleteRecordingHint':
      'Trajno ukloni sve audio, video, transkript i bilješke',
    'meeting.confirmDelete': 'Potvrdi brisanje'
  },
  bg: {
    'meeting.reprocessTranscriptHint':
      'Транскрибирай отново аудиото и регенерирай бележките от новия транскрипт',
    'meeting.reprocessNotesHint':
      'Регенерирай бележките с ИИ от съществуващия транскрипт',
    'meeting.reprocess': 'Преработи',
    'meeting.queued': 'В опашка...',
    'meeting.dangerZone': 'Опасна зона',
    'meeting.cannotUndo': 'Това действие не може да се отмени.',
    'meeting.deleteRecording': 'Изтрий записа',
    'meeting.deleteRecordingHint':
      'Премахни за постоянно всички аудио, видео, транскрипт и бележки',
    'meeting.confirmDelete': 'Потвърди изтриването'
  },
  ro: {
    'meeting.reprocessTranscriptHint':
      'Retranscrie audio-ul și regenerează notele din noua transcriere',
    'meeting.reprocessNotesHint': 'Regenerează notele AI din transcrierea existentă',
    'meeting.reprocess': 'Reprocesează',
    'meeting.queued': 'În coadă...',
    'meeting.dangerZone': 'Zonă periculoasă',
    'meeting.cannotUndo': 'Această acțiune nu poate fi anulată.',
    'meeting.deleteRecording': 'Șterge înregistrarea',
    'meeting.deleteRecordingHint':
      'Elimină permanent tot audio-ul, video-ul, transcrierea și notele',
    'meeting.confirmDelete': 'Confirmă ștergerea'
  },
  hu: {
    'meeting.reprocessTranscriptHint':
      'Hanganyag újraátirata és jegyzetek regenerálása az új átiratból',
    'meeting.reprocessNotesHint': 'AI-jegyzetek regenerálása a meglévő átiratból',
    'meeting.reprocess': 'Újrafeldolgozás',
    'meeting.queued': 'Várakozik...',
    'meeting.dangerZone': 'Veszélyes zóna',
    'meeting.cannotUndo': 'Ez a művelet nem vonható vissza.',
    'meeting.deleteRecording': 'Felvétel törlése',
    'meeting.deleteRecordingHint':
      'Az összes hang, videó, átirat és jegyzet végleges eltávolítása',
    'meeting.confirmDelete': 'Törlés megerősítése'
  },
  el: {
    'meeting.reprocessTranscriptHint':
      'Επαναμεταγραφή ήχου και αναγέννηση σημειώσεων από τη νέα μεταγραφή',
    'meeting.reprocessNotesHint':
      'Αναγέννηση σημειώσεων AI από την υπάρχουσα μεταγραφή',
    'meeting.reprocess': 'Επανεπεξεργασία',
    'meeting.queued': 'Σε αναμονή...',
    'meeting.dangerZone': 'Επικίνδυνη ζώνη',
    'meeting.cannotUndo': 'Αυτή η ενέργεια δεν μπορεί να αναιρεθεί.',
    'meeting.deleteRecording': 'Διαγραφή εγγραφής',
    'meeting.deleteRecordingHint':
      'Μόνιμη αφαίρεση όλου του ήχου, βίντεο, μεταγραφής και σημειώσεων',
    'meeting.confirmDelete': 'Επιβεβαίωση διαγραφής'
  },
  et: {
    'meeting.reprocessTranscriptHint':
      'Transkribeeri heli uuesti ja loo märkmed uuest transkriptsioonist',
    'meeting.reprocessNotesHint':
      'Loo AI märkmed uuesti olemasolevast transkriptsioonist',
    'meeting.reprocess': 'Töötle uuesti',
    'meeting.queued': 'Järjekorras...',
    'meeting.dangerZone': 'Ohtlik tsoon',
    'meeting.cannotUndo': 'Seda toimingut ei saa tagasi võtta.',
    'meeting.deleteRecording': 'Kustuta salvestis',
    'meeting.deleteRecordingHint':
      'Eemalda jäädavalt kogu heli, video, transkriptsioon ja märkmed',
    'meeting.confirmDelete': 'Kinnita kustutamine'
  },
  lv: {
    'meeting.reprocessTranscriptHint':
      'Atkārtoti atšifrēt audio un atkārtoti ģenerēt piezīmes no jaunā atšifrējuma',
    'meeting.reprocessNotesHint':
      'Atkārtoti ģenerēt AI piezīmes no esošā atšifrējuma',
    'meeting.reprocess': 'Apstrādāt atkārtoti',
    'meeting.queued': 'Rindā...',
    'meeting.dangerZone': 'Bīstamā zona',
    'meeting.cannotUndo': 'Šo darbību nevar atsaukt.',
    'meeting.deleteRecording': 'Dzēst ierakstu',
    'meeting.deleteRecordingHint':
      'Neatgriezeniski noņemt visus audio, video, atšifrējumu un piezīmes',
    'meeting.confirmDelete': 'Apstiprināt dzēšanu'
  },
  lt: {
    'meeting.reprocessTranscriptHint':
      'Iš naujo transkribuoti garsą ir generuoti pastabas iš naujo transkripto',
    'meeting.reprocessNotesHint': 'Iš naujo generuoti DI pastabas iš esamo transkripto',
    'meeting.reprocess': 'Apdoroti iš naujo',
    'meeting.queued': 'Eilėje...',
    'meeting.dangerZone': 'Pavojinga zona',
    'meeting.cannotUndo': 'Šio veiksmo negalima atšaukti.',
    'meeting.deleteRecording': 'Ištrinti įrašą',
    'meeting.deleteRecordingHint':
      'Visam laikui pašalinti visą garsą, vaizdo įrašą, transkriptą ir pastabas',
    'meeting.confirmDelete': 'Patvirtinti ištrynimą'
  }
}
