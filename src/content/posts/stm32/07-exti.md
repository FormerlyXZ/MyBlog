---
title: "第七章 EXTI：外部中断原理与按钮实验"
description: "EXTI 外部中断的工作原理、AFIO 与 EXTI 配置，并用外部中断重做按钮实验。"
date: 2026-10-25
image: "/images/series/stm32/ch7/01.webp"
categories: ["学习笔记"]
tags: ["STM32", "嵌入式", "学习笔记", "单片机"]
series: stm32
seriesOrder: 7
---
## 7.1 [EXTI]工作原理

EXTI：外部中断和事件控制器，捕捉输入信号的变换，并产生中断

### EXTI 模块简介
![](/images/series/stm32/ch7/01.webp)

### EXTI 应用举例
![](/images/series/stm32/ch7/02.webp)

### 线的概念
![](/images/series/stm32/ch7/03.webp)

### 线的内部结构
![](/images/series/stm32/ch7/04.webp)

![](/images/series/stm32/ch7/05.webp)

## 7.2 [EXTI]按钮实验

### 搭建电路

![](/images/series/stm32/ch7/06.webp)

### 分配 EXTI 线

#### GPIO_EXTILineConfig

```c
void GPIO_EXTILineConfig(uint8_t GPIO_PortSource,  // 端口号
                         uint8_t GPIO_PinSource); // 线编号
```

##### 参数说明

* <code>GPIO_PortSource</code>（端口源）：指定要映射的 GPIO 端口，可选值：<code>GPIO_PortSourceGPIOA</code> / <code>GPIO_PortSourceGPIOB</code> / <code>GPIO_PortSourceGPIOC</code> / <code>GPIO_PortSourceGPIOD</code>
* <code>GPIO_PinSource</code>（线编号）：指定要映射的引脚编号，可选值：<code>GPIO_PinSource0 ~ GPIO_PinSource15</code>

##### 核心作用

通过**AFIO（复用功能 IO）模块**，将指定 GPIO 端口的指定引脚，绑定到对应的 EXTI（外部中断）线。

* 底层逻辑：STM32 中 “EXTI 线 x” 可接收 GPIOA/GPIOB/GPIOC/GPIOD 等端口的 “Pin x” 引脚触发信号，需通过该函数明确具体映射关系。

##### 前置必做操作

AFIO 属于 APB2 总线外设，使用该函数前**必须先开启 AFIO 时钟**，否则映射配置无效：

### 配置 EXTI 线的参数

#### EXTI_Init

```c
void EXTI_Init(EXTI_InitTypeDef *EXTI_InitStruct);
```

**作用**：初始化指定的一条 EXTI（外部中断 / 事件）线，配置其触发方式、工作模式、使能状态等核心参数。

#####  参数说明

```c
struct EXTI_InitTypeDef{
    uint32_t EXTI_Line;                // 线编号
    EXTIMode_TypeDef EXTI_Mode;        // 工作模式
    EXTIMode_TypeDef EXTI_Trigger;     // 触发边沿
    FunctionalState EXTI_LineCmd;      // 使能/禁用开关
};
```

| 结构体成员 | 取值范围 / 说明 |
| --- | --- |
| `EXTI_Line` | 可选 `EXTI_Line0 ~ EXTI_Line19`<br/>，指定要配置的 EXTI 线编号（共 20 条 EXTI 线）； |
| `EXTI_Mode` | - `EXTI_Mode_Interrupt`<br/>：中断模式（触发后向 NVIC 发中断请求，需写中断服务函数）- `EXTI_Mode_Event`<br/>：事件模式（仅触发硬件事件，无 CPU 中断）； |
| `EXTI_Trigger` | - `EXTI_Trigger_Rising`<br/>：上升沿触发- `EXTI_Trigger_Falling`<br/>：下降沿触发- `EXTI_Trigger_Rising_Falling`<br/>：双边沿触发； |
| `EXTI_LineCmd` | - `ENABLE`<br/>：使能该 EXTI 线- `DISABLE`<br/>：禁用该 EXTI 线； |

##### 触发逻辑

EXTI 线的触发流程：

1. GPIO 引脚信号先经过**边沿检测电路**，筛选出上升沿 / 下降沿 / 双边沿信号；
2. 筛选后的信号可选择 “软件触发” 补充；
3. 最终信号根据<code>EXTI_Mode</code>配置，分为两路输出：
   * 中断路径：向 NVIC 发送中断请求，CPU 响应后执行中断服务函数；
   * 事件路径：仅触发硬件事件（如定时器启动、ADC 采集），无需 CPU 参与。

### 配置 NVIC 模块

#### 确定中断响应函数的名称

##### EXTI9_5_IRQHandler

```c
void EXTI9_5_IRQHandler(void);

void EXTI9_5_IRQHandler(void)
{	
    if(EXTI_GetFlagStatus(EXTI_Line5) == SET)
    {
        EXTI_ClearFlag(EXTI_Line5); // 清除EXTI5中断标志位
        GPIO_WriteBit(GPIOC, GPIO_Pin_13, Bit_RESET); // 亮灯
        
    }
    
    if(EXTI_GetFlagStatus(EXTI_Line6) == SET)
    {
        EXTI_ClearFlag(EXTI_Line6); // 清除EXTI6中断标志位
        GPIO_WriteBit(GPIOC, GPIO_Pin_13, Bit_SET);   // 灭灯（修正参数）
    }
}
```

#### 判断哪条线触发中断

##### EXTI_GetFlagStatus

```c
FlagStatus EXTI_GetFlagStatus(uint32_t EXTI_Line);
```

###### 核心作用

读取指定 EXTI 线的**中断标志位状态**，判断该 EXTI 线是否触发了中断（标志位是否置 1），是 EXTI 中断服务函数中 “精准识别中断源” 的核心函数。

###### 参数/返回值

* 参数 <code>EXTI_Line</code>：要查询的 EXTI 线编号（如<code>EXTI_Line5</code>、<code>EXTI_Line6</code>）；
* 返回值 <code>FlagStatus</code>：枚举类型，<code>SET</code>（标志位置 1，中断触发）/<code>RESET</code>（标志位清零，无中断）。

###### 适用场景

STM32 的 EXTI 中断通道按区间复用：

* EXTI0~EXTI4：各占独立中断通道（如 EXTI0_IRQn）；
* EXTI5~EXTI9：共用 <code>EXTI9_5_IRQn</code> 通道 → 需在<code>EXTI9_5_IRQHandler</code>中区分具体中断源；
* EXTI10~EXTI15：共用 <code>EXTI15_10_IRQn</code> 通道。

#### 清除标志位

##### EXTI_ClearFlag

```c
void EXTI_ClearFlag(uint32_t EXTI_Line);
```

**标志位清除（核心必做）**：

* 中断触发后硬件会自动置位标志位，若不手动调用<code>EXTI_ClearFlag</code>清除，标志位会一直为<code>SET</code>；
* 未清除标志位会导致 NVIC 持续向 CPU 发中断请求，中断服务函数被**无限重复调用**；

### 编写中断响应函数

```c
#include "stm32f10x.h"

void App_OnBoardLED_Init(void);
void App_Button_Init(void);
void EXTI9_5_IRQHandler(void);

int main(void)
{	
    NVIC_PriorityGroupConfig(NVIC_PriorityGroup_2);
    
    App_OnBoardLED_Init();
    App_Button_Init();
    
    while(1)
    {
    }
}

void App_OnBoardLED_Init(void)
{
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOC, ENABLE);
    GPIO_InitTypeDef GPIO_InitStruct;

    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_13;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_Out_OD;
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_2MHz;
    GPIO_Init(GPIOC, &GPIO_InitStruct);

    GPIO_WriteBit(GPIOC, GPIO_Pin_13, Bit_SET);
}

void App_Button_Init(void)
{
    // #1. 初始化PA5 | PA6
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);

    GPIO_InitTypeDef GPIO_InitStruct;
    
    // PA5
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_5;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_IPU;
    GPIO_Init(GPIOA, &GPIO_InitStruct);

    // PA6
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_6;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_IPU;
    GPIO_Init(GPIOA, &GPIO_InitStruct);

    // #2. 为EXTI5和EXTI6分配引脚
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_AFIO, ENABLE);
    GPIO_EXTILineConfig(GPIO_PortSourceGPIOA, GPIO_PinSource5);
    GPIO_EXTILineConfig(GPIO_PortSourceGPIOA, GPIO_PinSource6);

    // #3. 初始化EXTI的线
    EXTI_InitTypeDef EXTI_InitStruct;
    
    EXTI_InitStruct.EXTI_Line = EXTI_Line5;
    EXTI_InitStruct.EXTI_Mode = EXTI_Mode_Interrupt;
    EXTI_InitStruct.EXTI_Trigger = EXTI_Trigger_Rising;
    EXTI_InitStruct.EXTI_LineCmd = ENABLE;
    EXTI_Init(&EXTI_InitStruct);

    EXTI_InitStruct.EXTI_Line = EXTI_Line6;
    EXTI_InitStruct.EXTI_Mode = EXTI_Mode_Interrupt;
    EXTI_InitStruct.EXTI_Trigger = EXTI_Trigger_Rising;
    EXTI_InitStruct.EXTI_LineCmd = ENABLE;
    EXTI_Init(&EXTI_InitStruct);

    // #4. 配置中断
    NVIC_InitTypeDef NVIC_InitStruct;

    NVIC_InitStruct.NVIC_IRQChannel = EXTI9_5_IRQn;
    NVIC_InitStruct.NVIC_IRQChannelPreemptionPriority = 0;
    NVIC_InitStruct.NVIC_IRQChannelSubPriority = 0;
    NVIC_InitStruct.NVIC_IRQChannelCmd = ENABLE;

    NVIC_Init(&NVIC_InitStruct);
}

void EXTI9_5_IRQHandler(void)
{
    if(EXTI_GetFlagStatus(EXTI_Line5) == SET)
    {
        GPIO_WriteBit(GPIOC, GPIO_Pin_13, Bit_RESET); // 亮灯
        EXTI_ClearFlag(EXTI_Line5); // 清除EXTI5中断标志位
    }
    
    if(EXTI_GetFlagStatus(EXTI_Line6) == SET)
    {
        GPIO_WriteBit(GPIOC, GPIO_Pin_13, Bit_SET);   // 灭灯（修正参数）
        EXTI_ClearFlag(EXTI_Line6); // 清除EXTI6中断标志位
    }
}
```
