# AGENTS.md

## 项目概览
51Talk好评截图上传H5页面，用于引导学员上传订单好评截图并填写订单ID，审核通过后获得36,000香蕉币奖励。

## 技术栈
- 原生HTML/CSS/JavaScript
- Python http.server（静态文件服务）
- 移动端适配（375px-414px）

## 项目结构
```
.
├── index.html          # 主页面
├── styles/
│   └── main.css        # 样式文件
├── public/
│   ├── logo.png            # 51Talk品牌Logo
│   ├── toki-greeting.gif   # Toki打招呼GIF（戴耳机）
│   └── toki-celebrate.gif  # Toki庆祝GIF（无耳机）
── assets/                 # 原始素材目录
── .coze               # 项目配置
── DESIGN.md           # 设计规范
```

## 核心功能
1. **图片上传**：支持JPG/PNG/HEIC格式，最大10MB，带预览和删除功能
2. **订单ID输入**：带清除按钮和输入验证，限制为69开头的19位数字
3. **表单验证**：实时验证上传和输入状态，控制提交按钮
4. **状态切换**：提交前表单 → 提交中 → 提交成功页面
5. **动效**：页面上移渐显、上传成功边框变色、成功页飘动动画

## 开发命令
```bash
# 启动开发服务器
python -m http.server 5000 --bind 0.0.0.0

# 访问页面
http://localhost:5000
```

## 设计规范
详见 `DESIGN.md` 文件，包含：
- 品牌色彩：#4F46E5（蓝）、#FFEB3C（黄）
- 页面背景：#F6F7FB
- 卡片圆角：20px
- 按钮高度：54px
- 字体：系统默认字体栈

## 注意事项
1. 页面适配iPhone底部安全区域（env(safe-area-inset-bottom)）
2. 图片上传使用FileReader进行本地预览
3. 提交按钮在未填写完整时禁用
4. 成功页面不显示"再次上传"按钮
5. 页面离开时如有未提交内容会提示用户
6. Toki角色使用GIF格式，背景透明，动作循环自然
