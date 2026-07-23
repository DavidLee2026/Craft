# 每日绘 Craft 🖊️✨

AI 陪伴式绘画 App——只需要一张纸和一支笔就可以开始。

手机拍下纸上的画，AI 给你温暖的反馈，见证你的每天进步。

## 快速开始

```bash
pip install -r requirements.txt
python3 app.py
```

手机连接同 Wi-Fi，浏览器访问 `http://电脑IP:5001`。

## 功能

- **AI 识图反馈**：拍下画作，AI 三段式陪伴反馈
- **成长时间线**：所有画作时间轴，弹窗查看大图+完整反馈
- **连胜打卡**：🔥 连续绘画天数
- **日历视图**：月度热力图，直观看到坚持节奏
- **成长统计**：总画数、最长连胜、近 7 日频率柱状图
- **绘画术语库**：反馈中专业术语可点击查看大白话解释
- **分享图生成**：自动生成"第 1 天 vs 第 N 天"对比图

## 技术栈

- 后端：Flask + LLM API
- 前端：纯 HTML + CSS + JavaScript
- 数据：本地 JSON 文件存储

## 目录结构

```
├── app.py              # Flask 后端
├── requirements.txt    # 依赖
├── static/
│   └── index.html      # 前端页面
├── data/               # 用户数据（自动生成）
│   ├── images/         # 画作图片
│   ├── records.json    # 反馈记录
│   └── profile.json    # 用户档案
└── .env                # API Key 配置
```
