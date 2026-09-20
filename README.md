# 師団規模ウォーゲーム（スマホ投稿用・フラット構成）

フォルダなし・8ファイルだけで動く構成です。Android のスマホだけで GitHub に置けます。

## ファイル一覧（すべて同じ場所に置く）

```
index.html      manifest / Service Worker 登録を含む
manifest.json   PWA設定・アイコン参照
sw.js           キャッシュ・オフライン対応
style.css       見た目
config.js       設定（マップ・数値バランス・敵AI・部隊配置）
game.js         ゲーム本体
icon-192.svg    アイコン(192x192)
icon-512.svg    アイコン(512x512)
deploy.yml      自動デプロイ用（任意。置き場所は .github/workflows/）
```

## スマホだけで公開する手順

1. 各ファイルを端末にダウンロードする（「ダウンロード」フォルダに保存される）。
2. GitHub にログインし、新しいリポジトリを作る（Public。README の追加はオフ）。
3. リポジトリ画面で **Add file → Upload files**（または "uploading an existing file"）を開く。
4. 「ファイルを選択」から、ダウンロードフォルダで下の8ファイルを長押しして複数選択する。
   index.html / manifest.json / sw.js / style.css / config.js / game.js / icon-192.svg / icon-512.svg
5. **Commit changes** を押す。
6. **Settings → Pages → Build and deployment → Source** を **Deploy from a branch** にし、
   Branch を **main** / **(root)** にして Save。
7. 1〜2分後に `https://<ユーザー名>.github.io/<リポジトリ名>/` で開ける。
8. Chrome のメニューから「ホーム画面に追加」（または「アプリをインストール」）。

Chrome で GitHub の画面が崩れるときは、メニューの「PC版サイト」をオンにする。

## GitHub Actions で自動デプロイしたい場合（任意）

手順6の代わりに、次のようにする。

1. **Add file → Create new file** を開く。
2. ファイル名欄に `.github/workflows/deploy.yml` と入力する（`/` を打つとフォルダが作られる）。
3. 本文に deploy.yml の中身を貼り付けて Commit。
4. **Settings → Pages → Source** を **GitHub Actions** にする。

（ブランチ方式とは併用しない。どちらか一方でよい。）

## 更新したとき

変更のあったファイルだけを同じ名前で **Add file → Upload files** すれば上書きされる。
`sw.js` の `CACHE`（`division-wargame-v2`）の版数を上げてコミットすると、端末の古いキャッシュが入れ替わる。

## 画面の見かた（作戦指示画面）

- **上部バー：** 部隊ツリー（UNITS）・再生/一時停止・速度・作戦時刻（TURN と HRS）・状況パネル（SITREP）。
- **左パネル（UNITS）：** 師団の編成ツリー。人員・車両数・補給率のバー。部隊名をタップすると選択して地図を寄せる。
- **右パネル（SITREP）：** 再生/一時停止/早送り、航空優勢ゲージ、損害グラフ、補給グラフ、目標の進行、補給線の状態。
- **下部：** ミニマップ（タップ/ドラッグで移動）、無線ログ、指揮ボタン。
- 左右のパネルは開閉式。閉じたままだと地図が広く使える。
- TURN は作戦経過1分ごとに1つ進み、作戦時刻は1ターンで10分進む（0600 開始）。

## 遊び方

- 部隊アイコン（青の長方形）をタップして選択。もう一度タップで選択解除。
- **Issue Orders** → 進軍 / 攻撃 / 防御 を選び、地図をタップして目的地。続けてタップすると経由地。「完了」で終了。「待機」で停止。
- **Allocate Air Support / Airborne Drop** はボタンを押してから地点をタップ（使用回数とクールダウンあり）。
- **View Intelligence Reports** で発見した敵の一覧を確認。行をタップするとその位置へ。
- 地図の空きをタップすると、地形・補給路・砲撃可能範囲などのツールチップが出る。
- 青い矢印は各部隊の進撃ルート、赤い矢印は発見した敵の移動、点線の青/赤はフェーズライン。
- Request Fire Mission / Allocate Supply / Adjust ROE / Command Team Plan は準備中（押すと案内が出る）。
- 勝利条件：高地462を占領し、120秒間確保。制限時間18分。自動保存され、次回は「続きから」で再開。

## 調整するには

`config.js` の中身を編集する（マップ / 数値バランス / 敵AI / 部隊配置 / 画面UI の5ブロック）。
画面UIでは、作戦開始時刻・1ターンの長さ・航空優勢の計算式・フェーズラインの位置・編成ツリーのグループを変えられる。
