# UX-TTS-Bot

VOICEVOX の多彩な声で、Discord の読み上げをもっと自分らしく。話者・速度・ピッチをユーザーごとに設定できる、Web ダッシュボード付きの読み上げ Bot です。

**公式サイト: https://tts-promo.ux-labs.jp/**

- [導入ガイド](https://tts-promo.ux-labs.jp/guide) — サーバーへの追加から声のカスタマイズまで、3ステップで解説
- [コマンド一覧](https://tts-promo.ux-labs.jp/commands)
- [Discord に追加](https://discord.com/oauth2/authorize?client_id=1429102950722043944)

## できること

- **VOICEVOX の多彩な話者** — `/speaker` でユーザーごとに声を切り替え
- **ユーザー単位の設定** — 話速（`/set_speed`）・ピッチ（`/set_pitch`）を個人ごとに保存
- **読み上げ辞書** — マイ辞書（個人・最大10語）とサーバー共有辞書、インポート/エクスポートに対応
- **自動接続** — `/autojoin` で VC 入室と同時に読み上げを開始
- **ActiveSpeech** — 発話中は読み上げを待機し、会話と読み上げが重なるのを防止
- **Web ダッシュボード** — ブラウザから話者・速度・ピッチ・辞書をまとめて管理

## リポジトリ構成

`src/` 以下に本 Bot のソースコードを公開しています。

- `3LayerArchitecture/` — 現行の 3 層アーキテクチャ（Layer-A〜E）による実装
- `Unified Architecture/` — 旧・統合構成の実装（参考用）

公開方針や設定ファイルを同梱しない理由については [oss_philosophy.md](oss_philosophy.md) を、VOICEVOX キャラクタークレジットは [credit.md](credit.md) を参照してください。

## ライセンス

本プログラムは [GNU General Public License v3.0（GPLv3）](LICENSE) のもとで公開されています。

VOICEVOX や OpenJTalk など、自由ソフトウェアの恩恵を受けて成り立っているプロジェクトです。
