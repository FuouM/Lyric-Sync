# Model licenses

The code in this repository is Apache-2.0 ([LICENSE](LICENSE)). The model files (`*.onnx`, release assets listed in [models.json](models.json)) and the bundled dictionaries keep the licenses of their sources:

| File | Source | License |
|---|---|---|
| `packages/beatsync/models/beat_this.onnx`, `mel_fb_513x128.bin` | [Beat This!](https://github.com/CPJKU/beat_this) (Institute of Computational Perception, JKU Linz) | MIT |
| `packages/lyricsync/models/rmvpe/` | [RMVPE](https://github.com/Dream-High/RMVPE) | Apache-2.0 |
| `packages/lyricsync/models/harmof0/` | [HarmoF0](https://github.com/WX-Wei/HarmoF0) (Weixing Wei) | MIT |
| `packages/lyricsync/models/swift-f0/` | [Swift-F0](https://github.com/lars76/swift-f0) (Lars Nieradzik) | MIT |
| `packages/lyricsync/models/hubert-base/` | [HubertFA](https://github.com/wolfgitpr/HubertFA) multilingual singing model (wolfgitpr), on [chinese-hubert-base](https://huggingface.co/TencentGameMate/chinese-hubert-base) (MIT) | Apache-2.0 |
| `packages/lyricsync/models/hubert-combined/` | [Silasimo/HubertFA-combined](https://huggingface.co/Silasimo/HubertFA-combined) (Silas Antonisen, Iván López-Espejo), trained on GTSinger and SynthGT | **CC BY-NC-SA 4.0** |
| `packages/lyricsync/models/boundary/` | this project's syllable-boundary model: [mHuBERT-147](https://huggingface.co/utter-project/mHuBERT-147) backbone (CC BY-NC-SA 4.0), trained on [GTSinger](https://github.com/AaronZ345/GTSinger) (CC BY-NC-SA 4.0), fine-tuned on the "Namine Ritsu" singing database by Canon | **CC BY-NC-SA 4.0**, plus the Namine Ritsu terms below |
| `ds_cmudict-07b.txt`, `japanese_dict_full.txt` (in `hubert-*`) | HubertFA's dictionaries; the English one is derived from the CMU Pronouncing Dictionary (BSD-style) | as their sources |

**Non-commercial models.** `boundary/` and `hubert-combined/` are CC BY-NC-SA 4.0: no commercial use, credit the sources, and models derived from them carry the same license. `prepare` runs both for every song, whatever the solve method, so lyricsync as distributed with these models is for non-commercial use. beatsync uses only MIT-licensed files.

## Credits

- GTSinger: Yu Zhang et al., "GTSinger: A Global Multi-Technique Singing Corpus with Realistic Music Scores for All Singing Tasks", NeurIPS 2024 Datasets and Benchmarks.
- HubertFA-combined: please cite Silas Antonisen and Iván López-Espejo, "Synthesizing Ground Truth Phoneme Boundaries with SynthGT: A Synthetically Generated Solo-Singing Corpus" (see the model card).
- mHuBERT-147: utter-project (NAVER LABS Europe, Horizon Europe UTTER project).
- **"Namine Ritsu" singing database by Canon** (「波音リツ」歌声データベース, https://canon-voice.com/). The boundary model was fine-tuned on it.

### Namine Ritsu terms, Article 7(3)

The terms of use of the Namine Ritsu singing database require this string in the readme of a model made with it:

```
　　　＿＿＿
　 .//⌒＿＿＿　＼　　+　　　　。　　　　　+　　　　。　　　　　＊　 　　　。
　//_／　　　 ＼＼　＼ 　　　　+　　　　。　　　　　+　　　　。　　　　　＊　 　　　。
　　　　　 　　　　＼＼　＼
　　＊　 　　　+　　(（　　 |　　　 イヤッッホォォォオオォオウ！
　　　　　　　　　　　|　　∩
　　　+　　　　。　　|　　|　|　＊　 　　　+　　　　。　　　　　+　　　。　+
　　　　　　　　　　　|　　|　|
　　　　　　　　　　　|　 /　| 　 ._　　 +　　　　。　　　　　+　　　　+　　　　　＊
　　　　　 ＼￣￣~/　　　/~￣ .＼
　　　　　　||＼　　~^~^~^~　 　　　 ＼　　　　+　　　　。　　　　　+　　　　+　　　　　＊
　　　　　　||＼||￣￣￣￣￣￣￣||￣　　　　　　　　　　　　　　それがＶＩＰクオリティ
　　　　　　||　 ||￣￣￣￣￣￣￣||　　　　　　　　　　　　　https://hebi.5ch.net/news4vip/
```
