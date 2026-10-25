---
title: "第二章 GPIO：输出输入模式与 LED、按钮实验"
description: "GPIO 的 4 种输出模式、IO 最大输出速度、4 种输入模式，以及闪灯与按钮实验。"
date: 2026-10-25
image: "/images/series/stm32/ch2/01.webp"
categories: ["学习笔记"]
tags: ["STM32", "嵌入式", "学习笔记", "单片机"]
series: stm32
seriesOrder: 2
---
## 2.1 [GPIO]4种输出模式

### 单片机内部结构框图
![](/images/series/stm32/ch2/01.webp)

Cortex-M3 CPU  是CPU内核，专门执行运算任务

GPIOA, B, C, D 等是片上外设，每个片上外设能独立完成一个任务，类似于人的手，而引脚PA0类似于手GPIOA上的手指

---

### GPIO的8种工作模式
每个GPIO的引脚都有8种工作模式

![](/images/series/stm32/ch2/02.webp)

####  I/O端口位的基本结构图
![](/images/series/stm32/ch2/03.webp)

上半部分主要负责输入

下半部分主要负责输出

#### 输出
##### 通用输出推挽
推 - Push - 向外推电流  与P-MOS有关

挽 - Pull - 从外向里拉电流  与N-MOS有关

0 低电压

1 高电压

两个MOS管交替导通，不能同时导通



通用：通过CPU直接控制电路

复用：通过其它片上外设控制电路

##### 通用输出开漏
开漏 - Open-Drain -MOS管漏极开路

漏极保持断开，称为开漏（P-MOS管保持断开）

0 低电压

1 高阻抗

![](/images/series/stm32/ch2/04.webp)

##### 复用输出开挽
##### 复用输出开漏
#### 输入
##### 输入上拉
##### 输入下拉
##### 输入浮空
##### 模拟模式

## 2.2 [GPIO]IO最大输出速度

### IO最大输出速度
向IO交替写0和1且输出不失真的最快速度，高低电平变化的波形不失真

---

### 上升时间、下降时间、保持时间
![](/images/series/stm32/ch2/05.webp)

### 限制IO输出速度的因素
上升时间、下降时间的长短影响最大输出速度，保持时间越长，性能越好

### 选取最大输出速度的方法
在芯片上标注了3种最佳速度，分别是低速、中速、高速

选取满足要求的最小值，过于陡峭会增加耗电并引入EMI问题（对其他电子元器件产生电磁干扰）

人眼识别的临界频率为45.8Hz，交流电的频率为50Hz

![](/images/series/stm32/ch2/06.webp)

## 2.3 [GPIO]LED闪灯实验

D1：LED 指示灯，单片机接电源时亮

D2：PC13 开漏接法

### 第一步：开启GPIOx的时钟

参数1：需要开启的模块的名称；参数2：ENABLE 开启

```c
// 示例：开启GPIOx时钟
RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOx, ENABLE);
```

```c
// 示例：开启GPIOC时钟
RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOC, ENABLE);
```

#### GPIO模块编程接口

##### GPIO_Init

* 初始化IO引脚

配置引脚的工作模式、最大输出速度

##### GPIO_WriteBit

* 向输出数据寄存器写 1 个比特位

通过CPU向寄存器写0/1，从而控制引脚的输出电压

##### GPIO_ReadInputDataBit

* 从输入数据寄存器读 1 个比特位

##### GPIO_ReadQutputDataBit

* 从输出数据寄存器读 1 个比特位

读取最近一次 GPIO_WriteBit 在输出数据寄存器中写入的值

### 第二步：初始化IO引脚

```c
// 示例：初始化IO引脚
void GPIO_Init(GPIOTypeDef *GPIOx,					// 端口号，取ABCD
              GPIO_InitTypeDef *GPIO_InistStruct);	// 初始化的参数结构体指针
```

```c
struct GPIO_InitTypeDef {
    uint16_t GPIO_Pin;    // 引脚编号，可选值：GPIO_Pin_0 ~ GPIO_Pin_15
    GPIOSpeed_TypeDef GPIO_Speed;  // 最大输出速度
    GPIOMode_TypeDef GPIO_Mode;    // 引脚工作模式
};
```

#### （1）引脚速度选项（<code>GPIO_Speed</code>）

* <code>GPIO_Speed_2MHz</code>：2MHz
* <code>GPIO_Speed_10MHz</code>：10MHz
* <code>GPIO_Speed_50MHz</code>：50MHz

#### （2）引脚模式选项（<code>GPIO_Mode</code>）

##### 输出模式：

* <code>GPIO_Mode_Out_PP</code>：通用推挽输出
* <code>GPIO_Mode_Out_OD</code>：通用开漏输出
* <code>GPIO_Mode_AF_PP</code>：复用推挽输出
* <code>GPIO_Mode_AF_OD</code>：复用开漏输出

##### 输入模式：

* <code>GPIO_Mode_IPU</code>：上拉输入
* <code>GPIO_Mode_IPD</code>：下拉输入
* <code>GPIO_Mode_IN_FLOATING</code>：浮空输入
* <code>GPIO_Mode_AIN</code>：模拟输入

```c
// 初始化IO引脚，PC13设置为开漏模式，2MHz
GPIO_InitTypeDef GPIO_InitStruct = {0};

GPIO_InitStruct.GPIO_Pin = GPIO_Pin_13;
GPIO_InitStruct.GPIO_Mode = GPIO_Mode_Out_OD;
GPIO_InitStruct.GPIO_Speed = GPIO_Speed_2MHz;

GPIO_Init(GPIOC, &GPIO_InitStruct);
```

### 第三步： 向指定的 IO 引脚写入电平值（0 或 1）

向指定的 IO 引脚写入电平值（0 或 1）。

```c
void GPIO_WriteBit(GPIO_TypeDef *GPIOx,  // 端口号，如 GPIOA、GPIOB、GPIOC 等
                   uint16_t GPIO_Pin,    // 引脚编号，如 GPIO_Pin_13
                   BitAction BitValue);  // 要写入的电平值
```

<code>BitValue</code>：要写入的电平值：

* <code>Bit_RESET</code>：写入低电平（0）
* <code>Bit_SET</code>：写入高电平（1）

```c
GPIO_WriteBit(GPIOC, GPIO_Pin_13, Bit_RESET); // 向PC13引脚写0，LED点亮
GPIO_WriteBit(GPIOC, GPIO_Pin_13, Bit_SET);   // 向PC13引脚写1，LED熄灭
```

```c
#include "delay.h"

while(1)
{
    GPIO_WriteBit(GPIOC, GPIO_Pin_13, Bit_RESET); // 向PC13引脚写0，LED点亮
    Delay(100);  // 延迟100ms，Delay是从外部引入的函数
    GPIO_WriteBit(GPIOC, GPIO_Pin_13, Bit_SET);   // 向PC13引脚写1，LED熄灭
    Delay(100);	 // 延迟100ms
}
```

![](/images/series/stm32/ch2/07.webp)

#### 完整实验代码

```c
#include "stm32f10x.h"
#include "delay.h"

int main(void)
{
	// #1.开启GPIOC时钟
	RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOC, ENABLE);
	
	// 初始化IO引脚，PC13设置为开漏模式，2MHz
	GPIO_InitTypeDef GPIO_InitStruct = {0};

	GPIO_InitStruct.GPIO_Pin = GPIO_Pin_13;
	GPIO_InitStruct.GPIO_Mode = GPIO_Mode_Out_OD;
	GPIO_InitStruct.GPIO_Speed = GPIO_Speed_2MHz;
	
	GPIO_Init(GPIOC, &GPIO_InitStruct);
	
	// GPIO_WriteBit(GPIOC, GPIO_Pin_13, Bit_SET);   // 向PC13引脚写1，LED熄灭
	
	// GPIO_WriteBit(GPIOC, GPIO_Pin_13, Bit_RESET); // 向PC13引脚写0，LED点亮
	
	while(1)
	{
		GPIO_WriteBit(GPIOC, GPIO_Pin_13, Bit_RESET); // 向PC13引脚写0，LED点亮
		Delay(100);  // 延迟100ms
		GPIO_WriteBit(GPIOC, GPIO_Pin_13, Bit_SET);   // 向PC13引脚写1，LED熄灭
		Delay(100);
	}
}

```

## 2.4 [GPIO]4种输入模式

![](/images/series/stm32/ch2/03.webp)
简化输入电路

![](/images/series/stm32/ch2/09.webp)

#### 输入
##### 输入上拉
闭合 上拉电阻 所在电路的开关

作用：提供默认的高电压。当引脚悬空时，提供高电压，输入数据寄存器得到稳定的1，引脚连接时无影响

施密特触发器：将高低电压转换为 0/1，施密特触发器经过的电流必须为 0，R=∞

![](/images/series/stm32/ch2/10.webp)

##### 输入下拉
闭合 下拉电阻 所在电路的开关

作用：提供默认的低电压。当引脚悬空时，提供低电压，输入数据寄存器得到稳定的0，引脚连接时无影响

##### 输入浮空
同时断开 上拉电阻 和 下拉电阻 所在电路的开关

##### 模拟模式

## 2.5 [GPIO]按钮实验

![](/images/series/stm32/ch2/11.webp)

### LED的接线方法

![](/images/series/stm32/ch2/12.webp)

![](/images/series/stm32/ch2/13.webp)

#### 测试电路连接是否正确

#### 测试代码

```c
#include "stm32f10x.h"

int main(void)
{
	RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE); // 开启GPIOA的时钟
	
	GPIO_InitTypeDef GPIO_InitStruct;
    
    // 选择要初始化的引脚为PA0
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_0;
    // 设置引脚模式为通用推挽输出
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_Out_PP;
    // 设置引脚最大输出速度为2MHz
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_2MHz;
	GPIO_Init(GPIOA, &GPIO_InitStruct); // 初始化PA0引脚

    GPIO_WriteBit(GPIOA, GPIO_Pin_0, Bit_SET); // 向PA0写入高电平(1)，点亮LED
}
```

编译 -> 下载 -> 按复位按钮

### 按钮的接线方法

#### 按钮电路工作原理图

![](/images/series/stm32/ch2/14.webp)

![](/images/series/stm32/ch2/15.webp)

注意：按钮中有引脚的一端朝上

```c
// RCC_APB2PeriphClockCmd(GPIOA, ENABLE); 	// 已开启，无需再次开启

// GPIO_InitTypeDef GPIO_InitStruct; 	// 已声明，无需再次声明
GPIO_InitStruct.GPIO_Pin = GPIO_Pin_1;
GPIO_InitStruct.GPIO_Mode = GPIO_Mode_IPU; // 上拉输入模式
// GPIO_InitStruct.GPIO_Speed = ...; 	// 最大输出速度只对输出模式有效

GPIO_Init(GPIOA, &GPIO_InitStruct);
```

### 编程接口和代码

<code>GPIO_ReadInputDataBit</code> 是**STM32 标准库**中专门用于读取**单个 GPIO 引脚输入电平状态**的核心函数，直白来说，它的作用就是「检测指定 IO 口当前是高电平还是低电平」。

* <code>GPIO_ReadInputDataBit</code> 是**读单个 GPIO 引脚输入电平**的专用函数，返回高 / 低电平状态；
* 使用前必须将引脚配置为**输入模式**（上拉 / 下拉 / 浮空）；
* 核心用途是检测外部输入信号（如按键、传感器），是嵌入式开发中最常用的函数之一。

#### GPIO_ReadInputDataBit 函数笔记

```c
uint8_t GPIO_ReadInputDataBit(GPIO_TypeDef *GPIOx,  // 端口号，如 GPIOA、GPIOB 等
                              uint16_t GPIO_Pin);   // 引脚编号，如 GPIO_Pin_1
```

作用：读取指定 IO 引脚的**输入电平值**，返回值：

* <code>Bit_SET</code>：表示高电平（1）
* <code>Bit_RESET</code>：表示低电平（0）

```c
while(1) {
    // 读取 PA1 引脚电平，判断按钮是否按下
    if(GPIO_ReadInputDataBit(GPIOA, GPIO_Pin_1) == Bit_RESET) {
        GPIO_WriteBit(GPIOA, GPIO_Pin_0, Bit_SET);  // 按钮按下，LED 亮
    } else {
        GPIO_WriteBit(GPIOA, GPIO_Pin_0, Bit_RESET); // 按钮松开，LED 灭
    }
}
```

#### 完整实验代码

```c
#include "stm32f10x.h"

int main(void)
{
	RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE); // 开启GPIOA的时钟
	
	GPIO_InitTypeDef GPIO_InitStruct;
    
    // 选择要初始化的引脚为PA0
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_0;
    // 设置引脚模式为通用推挽输出
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_Out_PP;
    // 设置引脚最大输出速度为2MHz
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_2MHz;
	GPIO_Init(GPIOA, &GPIO_InitStruct); // 初始化PA0引脚

    // GPIO_WriteBit(GPIOA, GPIO_Pin_0, Bit_SET); // 向PA0写入高电平(1)，点亮LED

    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_1;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_IPU; // 上拉输入模式
    GPIO_Init(GPIOA, &GPIO_InitStruct); // 初始化PA1引脚

    while(1)
    {
        // 读取 PA1 引脚电平，判断按钮是否按下
        if(GPIO_ReadInputDataBit(GPIOA, GPIO_Pin_1) == Bit_RESET)
        {
        GPIO_WriteBit(GPIOA, GPIO_Pin_0, Bit_SET);  // 按钮按下，LED 亮
        } 
        else 
        {
        GPIO_WriteBit(GPIOA, GPIO_Pin_0, Bit_RESET); // 按钮松开，LED 灭
        }
    }
}
```
