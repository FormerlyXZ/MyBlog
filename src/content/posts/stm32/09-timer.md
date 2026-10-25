---
title: "第九章 定时器：时基单元、PWM 与输入捕获"
description: "时基单元与自制延迟函数、输出比较与呼吸灯、输入捕获、超声波测距、从模式控制器、PWM 参数测量。"
date: 2026-10-25
image: "/images/series/stm32/ch9/01.webp"
categories: ["学习笔记"]
tags: ["STM32", "嵌入式", "学习笔记", "单片机"]
series: stm32
seriesOrder: 9
---
## 9.1 [定时器]时基单元

### 定时器简介
| 定时器类别 | 核心型号 | 核心功能 | 总线归属 | 适用场景 |
| --- | --- | --- | --- | --- |
| 基本定时器 | TIM6/TIM7 | 仅基础向上计数、定时中断，支持 DAC 触发；无 IO 输出 / 捕获 / 比较 / PWM 功能 | APB1 | 简单定时、喂看门狗、DAC 触发 |
| 通用定时器 | TIM2/TIM3/TIM4/TIM5 | 向上 / 向下 / 中央对齐计数，支持 PWM 输出、输入捕获、编码器接口 | APB1 | PWM 驱动、脉冲测量、编码器测速、常规定时 |
| 高级定时器 | TIM1/TIM8 | 含通用定时器所有功能，新增死区控制、互补输出、刹车 / 断路、三相 PWM | APB2 | 工业电机驱动、大功率变频器、硬件保护场景 |


![](/images/series/stm32/ch9/01.webp)

### 时基单元的基本结构
![](/images/series/stm32/ch9/02.webp)

### 上计数、下计数和中心对齐
![](/images/series/stm32/ch9/03.webp)

### 时钟的来源
![](/images/series/stm32/ch9/04.webp)

![](/images/series/stm32/ch9/05.webp)

### 寄存器预加载
![](/images/series/stm32/ch9/06.webp)

+ **核心结构**：寄存器分为**影子寄存器**（软件写入目标）和**活动寄存器**（硬件实际生效的寄存器）
+ **写入与生效流程**：
+ 软件直接写入 → **影子寄存器**（暂存新值，不立即影响硬件计数）
+ 当**更新事件（update）****发生时 → 影子寄存器的值加载到****活动寄存器** → 新配置正式生效
+ **设计意义**：
+ 避免计数中途修改寄存器导致的计数紊乱
+ 保证定时器行为的同步性与稳定性，防止中间状态干扰
+ 典型场景：修改 ARR/PSC 等关键寄存器时，新值会在下一个更新周期才生效，确保计数周期完整

## 9.2 [定时器]自制延迟函数

![](/images/series/stm32/ch9/07.webp)

### 获取单片机的当前时间
![](/images/series/stm32/ch9/08.webp)



### 实现延迟函数
#### App_Delay
```c
void App_Delay(uint32_t ms);

void App_Delay(uint32_t ms)
{
    uint32_t expireTime = currentTick + ms;
    // 完整的非阻塞延时循环：等待当前时间超过到期时间
    while(currentTick < expireTime);
}
```

### 初始化时基单元
#### App_TIM3_TimeBaseInit
```c
void App_TIM3_TimeBaseInit(void);

void App_TIM3_TimeBaseInit(void)
{
    // #1. 开启定时器3的时钟
    RCC_APB1PeriphClockCmd(RCC_APB1Periph_TIM3, ENABLE);

    // #2. 配置时基单元的参数
    TIM_TimeBaseInitTypeDef TIM_TimeBaseInitStruct;

    TIM_TimeBaseInitStruct.TIM_Prescaler = 71;        // 预分频值
    TIM_TimeBaseInitStruct.TIM_Period = 999;          // 自动重装载值
    TIM_TimeBaseInitStruct.TIM_CounterMode = TIM_CounterMode_Up; // 向上计数模式
    TIM_TimeBaseInitStruct.TIM_RepetitionCounter = 0; // 重复计数器（高级定时器特有）

    // 初始化TIM3的时基单元
    TIM_TimeBaseInit(TIM3, &TIM_TimeBaseInitStruct);

    // #3. 闭合时基单元的开关
    TIM_Cmd(TIM3, ENABLE);

    // #4. 使能Update中断
    TIM_ITConfig(TIM3, TIM_IT_Update, ENABLE);

    // #5. 配置NVIC模块
    NVIC_InitTypeDef NVIC_InitStruct;
    
    NVIC_InitStruct.NVIC_IRQChannel = TIM3_IRQn;
    NVIC_InitStruct.NVIC_IRQChannelPreemptionPriority = 0;
    NVIC_InitStruct.NVIC_IRQChannelSubPriority = 0;
    NVIC_InitStruct.NVIC_IRQChannelCmd = ENABLE;
    
    NVIC_Init(&NVIC_InitStruct);
}
```

### 配置中断
#### TIM3_IRQHandler
```c
void TIM3_IRQHandler(void);

void TIM3_IRQHandler(void)
{
    if(TIM_GetFlagStatus(TIM3, TIM_FLAG_Update) == SET)
    {
        TIM_ClearFlag(TIM3, TIM_FLAG_Update);
        currentTick++;
    }
}
```

### 编写中断响应函数
此处需要取消注释startup_文件中的systeminit，否则闪烁时间约为4.5s

#### 完整实验代码
```c
#include "stm32f10x.h"

volatile uint32_t currentTick = 0; // 用来记录当前时间，单位是ms

void App_Delay(uint32_t ms);
void App_TIM3_TimeBaseInit(void);
void App_OnBoardLED_Init(void);

int main(void)
{	
    NVIC_PriorityGroupConfig(NVIC_PriorityGroup_2);
    App_TIM3_TimeBaseInit();
    App_OnBoardLED_Init();
    
    while(1)
    {
        GPIO_WriteBit(GPIOC, GPIO_Pin_13, Bit_RESET);
        App_Delay(500);
        GPIO_WriteBit(GPIOC, GPIO_Pin_13, Bit_SET);
        App_Delay(500);
    }
}

void App_Delay(uint32_t ms)
{
    uint32_t expireTime = currentTick + ms;
    // 完整的非阻塞延时循环：等待当前时间超过到期时间
    while(currentTick < expireTime);
}

void App_TIM3_TimeBaseInit(void)
{
    // #1. 开启定时器3的时钟
    RCC_APB1PeriphClockCmd(RCC_APB1Periph_TIM3, ENABLE);

    // #2. 配置时基单元的参数
    TIM_TimeBaseInitTypeDef TIM_TimeBaseInitStruct;

    TIM_TimeBaseInitStruct.TIM_Prescaler = 71;        // 预分频值
    TIM_TimeBaseInitStruct.TIM_Period = 999;          // 自动重装载值
    TIM_TimeBaseInitStruct.TIM_CounterMode = TIM_CounterMode_Up; // 向上计数模式
    TIM_TimeBaseInitStruct.TIM_RepetitionCounter = 0; // 重复计数器（高级定时器特有）

    // 初始化TIM3的时基单元
    TIM_TimeBaseInit(TIM3, &TIM_TimeBaseInitStruct);

    // #3. 闭合时基单元的开关
    TIM_Cmd(TIM3, ENABLE);

    // #4. 使能Update中断
    TIM_ITConfig(TIM3, TIM_IT_Update, ENABLE);

    // #5. 配置NVIC模块
    NVIC_InitTypeDef NVIC_InitStruct;
    
    NVIC_InitStruct.NVIC_IRQChannel = TIM3_IRQn;
    NVIC_InitStruct.NVIC_IRQChannelPreemptionPriority = 0;
    NVIC_InitStruct.NVIC_IRQChannelSubPriority = 0;
    NVIC_InitStruct.NVIC_IRQChannelCmd = ENABLE;
    
    NVIC_Init(&NVIC_InitStruct);
}

void TIM3_IRQHandler(void)
{
    if(TIM_GetFlagStatus(TIM3, TIM_FLAG_Update) == SET)
    {
        TIM_ClearFlag(TIM3, TIM_FLAG_Update);
        currentTick++;
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
```

## 9.3 [定时器]输出比较

### 输出比较简介
当定时器的计数器（CNT）值与捕获 / 比较寄存器（CCR）的值相等时，自动执行预设的**输出动作**（如电平翻转、置高 / 置低）或触发**中断 / DMA 请求**。  

### 基本工作原理（PWM）
![](/images/series/stm32/ch9/09.webp)

![](/images/series/stm32/ch9/10.webp)

### 8种工作模式
![](/images/series/stm32/ch9/11.webp)

![](/images/series/stm32/ch9/12.webp)

### 互补输出
![](/images/series/stm32/ch9/13.webp)

### 极性选择
![](/images/series/stm32/ch9/14.webp)

## 9.4 [定时器]呼吸灯实验

### 呼吸灯原理
![](/images/series/stm32/ch9/15.webp)

### 初始化IO引脚
![](/images/series/stm32/ch9/16.webp)

![](/images/series/stm32/ch9/17.webp)

注意第一排上的排针要在同一排上

![](/images/series/stm32/ch9/18.webp)

长脚为正极

![](/images/series/stm32/ch9/19.webp)

### 配置时基单元
![](/images/series/stm32/ch9/20.webp)

### 配置输出比较的参数
需要手动加载 自动重装寄存器ARR，预分频器PSC和重复计数器RCR 自动加载。

![](/images/series/stm32/ch9/21.webp)

### 改变PWM占空比
需要手动加载 比较寄存器x CCRx

![](/images/series/stm32/ch9/22.webp)

#### 完整实验代码
```c
#include "stm32f10x.h"
#include "delay.h"	// 用于获取当前时间t
#include "math.h"	// 引入正弦函数

void App_PWM_Init(void);

int main(void)
{
    App_PWM_Init();
    while(1)
    {
        float t = GetTick() * 1.0e-3f;
        float duty = 0.5*(sin(2*3.14*t) + 1);
        uint16_t ccr1 = duty * 1000;

        TIM_SetCompare1(TIM1, ccr1);
    }
}

void App_PWM_Init(void)
{	
    // #1. 初始化IO引脚 PA8 PB13
    GPIO_InitTypeDef GPIO_InitStruct;

    // PA8
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);
    
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_8;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_AF_PP;
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_2MHz;
    
    GPIO_Init(GPIOA, &GPIO_InitStruct);

    // PB13
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOB, ENABLE);
    
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_13;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_AF_PP;
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_2MHz;
    
    GPIO_Init(GPIOB, &GPIO_InitStruct);

    // #2. 配置时基单元
    // #2.1 开启TIM1的时钟
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_TIM1, ENABLE);
    
    // #2.2 配置时基单元的参数
    TIM_TimeBaseInitTypeDef TIM_TimeBaseInitStruct;
    
    TIM_TimeBaseInitStruct.TIM_CounterMode = TIM_CounterMode_Up;
    TIM_TimeBaseInitStruct.TIM_Period = 999;
    TIM_TimeBaseInitStruct.TIM_Prescaler = 71;
    TIM_TimeBaseInitStruct.TIM_RepetitionCounter = 0;

    TIM_TimeBaseInit(TIM1, &TIM_TimeBaseInitStruct);

    // #2.3 开启ARR的预加载
    TIM_ARRPreloadConfig(TIM1, ENABLE);

    // #2.4 闭合时基单元的开关
    TIM_Cmd(TIM1, ENABLE);

    // #3. 初始化输出比较
    // #3.1 初始化输出比较通道1的参数
    
    TIM_OCInitTypeDef TIM_OCInitStruct;
    
    TIM_OCInitStruct.TIM_OCMode = TIM_OCMode_PWM1;
    TIM_OCInitStruct.TIM_OCNPolarity = TIM_OCNPolarity_High;
    TIM_OCInitStruct.TIM_OCPolarity = TIM_OCPolarity_High;
    TIM_OCInitStruct.TIM_OutputNState = TIM_OutputNState_Enable;
    TIM_OCInitStruct.TIM_OutputState = TIM_OutputState_Enable;
    TIM_OCInitStruct.TIM_Pulse = 0;

    TIM_OC1Init(TIM1, &TIM_OCInitStruct);

    // #3.2 闭合MOE总开关
    TIM_CtrlPWMOutputs(TIM1, ENABLE);
    TIM_CCPreloadControl(TIM1, ENABLE);
}
```

## 9.5 [定时器]输入捕获

### 输入捕获的基本原理
![](/images/series/stm32/ch9/23.webp)

### 输入捕获的内部结构
![](/images/series/stm32/ch9/24.webp)

### 输入滤波
输入滤波：滤除输入信号的噪音

![](/images/series/stm32/ch9/25.webp)

### 边沿检测
检测输入信号的变化边沿（上升沿 / 下降沿）

### 信号选择
复用器（TRC，直接，间接）

![](/images/series/stm32/ch9/26.webp)

### 分频器
![](/images/series/stm32/ch9/27.webp)

## 9.6 [定时器]超声波测距实验

### HCSR-04模块的使用方法
![](/images/series/stm32/ch9/28.webp)

![](/images/series/stm32/ch9/29.webp)

### 搭建电路
![](/images/series/stm32/ch9/30.webp)

![](/images/series/stm32/ch9/31.webp)

### 梳理思路
![](/images/series/stm32/ch9/32.webp)

![](/images/series/stm32/ch9/33.webp)

### 初始化时基单元
![](/images/series/stm32/ch9/34.webp)

![](/images/series/stm32/ch9/35.webp)

### 初始化输入捕获
#### TIM_ICInit
```c
// @参数：初始化输入捕获
void TIM_ICInit(TIM_TypeDef* TIMx, TIM_ICInitTypeDef* TIM_ICInitStruct);
```

### 编程
![](/images/series/stm32/ch9/36.webp)

#### 完整实验代码
```c
#include "stm32f10x.h"
#include "usart.h"
#include "delay.h"

void App_USART1_Init(void);
void App_HCSR04_Init(void);

int main(void)
{	
    App_USART1_Init();
    App_HCSR04_Init();
    
    while(1)
    {
        // #1. 向CNT写0
        TIM_SetCounter(TIM1, 0);
        
        // #2. 清除cc1和cc2标志位
        TIM_ClearFlag(TIM1, TIM_FLAG_CC1);
        TIM_ClearFlag(TIM1, TIM_FLAG_CC2);
        
        // #3. 开启定时器
        TIM_Cmd(TIM1, ENABLE);
        
        // #4. 向TRIG引脚发送10us的脉冲
        GPIO_WriteBit(GPIOA, GPIO_Pin_0, Bit_SET);
        DelayUs(10);	// 延迟10us
        GPIO_WriteBit(GPIOA, GPIO_Pin_0, Bit_RESET);

        // #5. 等待测量完成
        while (TIM_GetFlagStatus(TIM1, TIM_FLAG_CC1) == RESET);
        while (TIM_GetFlagStatus(TIM1, TIM_FLAG_CC2) == RESET);

        // #6. 关闭定时器
        TIM_Cmd(TIM1, DISABLE);
        
        uint16_t ccr1 = TIM_GetCapture1(TIM1);
        uint16_t ccr2 = TIM_GetCapture2(TIM1);
        
        float distance = (ccr2 - ccr1) * 1.0e-6f * 340.0f / 2;
        
        My_USART_Printf(USART1, "distance = %.4f\r\n", distance);
        
        Delay(100);
    }
}


void App_USART1_Init(void)
{
    // #1. 初始化IO引脚
    GPIO_InitTypeDef GPIO_InitStruct;
    
    // PA9 AF_PP
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_9;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_AF_PP;
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_10MHz;
    GPIO_Init(GPIOA, &GPIO_InitStruct);
    
    // PA10 IPU
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_10;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_IPU;
    GPIO_Init(GPIOA, &GPIO_InitStruct);

    // #2. 初始化USART1
    // #2.1 开启USART1的时钟
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_USART1, ENABLE);

    // #2.2 初始化USART1的参数
    USART_InitTypeDef USART_InitStruct;
    
    USART_InitStruct.USART_BaudRate = 115200;
    USART_InitStruct.USART_HardwareFlowControl = USART_HardwareFlowControl_None;
    USART_InitStruct.USART_Mode = USART_Mode_Tx | USART_Mode_Rx;
    USART_InitStruct.USART_Parity = USART_Parity_No;
    USART_InitStruct.USART_StopBits = USART_StopBits_1;
    USART_InitStruct.USART_WordLength = USART_WordLength_8b;
    
    USART_Init(USART1, &USART_InitStruct);

    // #2.3 闭合总开关
    USART_Cmd(USART1, ENABLE);
}

void App_HCSR04_Init(void)
{
    // #1. 初始化时基单元
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_TIM1, ENABLE);
    
    TIM_TimeBaseInitTypeDef TIM_TimeBaseInitStruct;
    
    TIM_TimeBaseInitStruct.TIM_CounterMode = TIM_CounterMode_Up;
    TIM_TimeBaseInitStruct.TIM_Period = 65535;
    TIM_TimeBaseInitStruct.TIM_Prescaler = 71;
    TIM_TimeBaseInitStruct.TIM_RepetitionCounter = 0;
    
    TIM_TimeBaseInit(TIM1, &TIM_TimeBaseInitStruct);

    // #2. 初始化输入捕获
    // #2.1. 初始化IO引脚 PA8 IPD
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);
    GPIO_InitTypeDef GPIO_InitStruct;
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_8;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_IPD;
    GPIO_Init(GPIOA, &GPIO_InitStruct);

    // #2.2. 初始化输入捕获的通道1
    TIM_ICInitTypeDef TIM_ICInitStruct;
    
    TIM_ICInitStruct.TIM_Channel = TIM_Channel_1;
    TIM_ICInitStruct.TIM_ICFilter = 0;
    TIM_ICInitStruct.TIM_ICPolarity = TIM_ICPolarity_Rising;
    TIM_ICInitStruct.TIM_ICPrescaler = TIM_ICPSC_DIV1;
    TIM_ICInitStruct.TIM_ICSelection = TIM_ICSelection_DirectTI;
    
    TIM_ICInit(TIM1, &TIM_ICInitStruct);

    // #2.3 初始化输入捕获的通道2
    TIM_ICInitStruct.TIM_Channel = TIM_Channel_2;
    TIM_ICInitStruct.TIM_ICFilter = 0;
    TIM_ICInitStruct.TIM_ICPolarity = TIM_ICPolarity_Falling;
    TIM_ICInitStruct.TIM_ICPrescaler = TIM_ICPSC_DIV1;
    TIM_ICInitStruct.TIM_ICSelection = TIM_ICSelection_IndirectTI;
    
    TIM_ICInit(TIM1, &TIM_ICInitStruct);

    // #3. 初始化Trig引脚
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);
    
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_0;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_Out_PP;
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_2MHz;
    
    GPIO_Init(GPIOA, &GPIO_InitStruct);
}
```

## 9.7 [定时器]从模式控制器

### 从模式控制器的概念
![](/images/series/stm32/ch9/37.webp)

![](/images/series/stm32/ch9/38.webp)

### 8种从模式
![](/images/series/stm32/ch9/39.webp)

### 8种主模式
![](/images/series/stm32/ch9/40.webp)

### 定时器同时启停案例
![](/images/series/stm32/ch9/41.webp)

### 定时器级联案例
![](/images/series/stm32/ch9/42.webp)

## 9.8 [定时器]PWM参数测量原理

PWM信号：周期恒定，占空比可调节

### 参考手册的定时器结构框图
![](/images/series/stm32/ch9/43.webp)

![](/images/series/stm32/ch9/37.webp)

### 输入捕获节点的名字
![](/images/series/stm32/ch9/45.webp)

### TRGI的来源
![](/images/series/stm32/ch9/46.webp)

### PWM参数测量原理
![](/images/series/stm32/ch9/47.webp)

## 9.9 [定时器]PWM参数测量实验

### 实验原理
![](/images/series/stm32/ch9/48.webp)

### 产生PWM信号
![](/images/series/stm32/ch9/49.webp)

#### 呼吸灯实验
```c
#include "stm32f10x.h"
#include "usart.h"
#include "delay.h"
#include <math.h>

void App_USART1_Init(void);
void App_TIM3_Init(void);

int main(void)
{
    App_USART1_Init();
    App_TIM3_Init();
    
    while (1)
    {
        float t = GetTick() * 1.0e-3f;
        float duty = 0.5 * (sin(2 * 3.14 * t) + 1);
        uint16_t ccrl = duty * 999;

        TIM_SetCompare1(TIM3, ccrl);
    }
}

void App_USART1_Init(void)
{
    // #1. 初始化IO引脚 PA9 AF_PP
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);

    GPIO_InitTypeDef GPIO_InitStruct = {0};
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_9;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_AF_PP;
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_10MHz;
    GPIO_Init(GPIOA, &GPIO_InitStruct);

    // #2.2 配置USART1的参数
    USART_InitTypeDef USART_InitStruct = {0};
    
    USART_InitStruct.USART_BaudRate = 115200;
    USART_InitStruct.USART_HardwareFlowControl = USART_HardwareFlowControl_None;
    USART_InitStruct.USART_Mode = USART_Mode_Tx;
    USART_InitStruct.USART_Parity = USART_Parity_No;
    USART_InitStruct.USART_StopBits = USART_StopBits_1;
    USART_InitStruct.USART_WordLength = USART_WordLength_8b;
    
    USART_Init(USART1, &USART_InitStruct);
    
    // #2.3 闭合总开关
    USART_Cmd(USART1, ENABLE);
}

void App_TIM3_Init(void)
{
    // #1. 初始化时基单元
    // #1.1 开启TIM3的时钟
    RCC_APB1PeriphClockCmd(RCC_APB1Periph_TIM3, ENABLE);

    // #1.2 配置时基单元的参数
    TIM_TimeBaseInitTypeDef TIM_TimeBaseInitStruct = {0};

    TIM_TimeBaseInitStruct.TIM_CounterMode = TIM_CounterMode_Up;
    TIM_TimeBaseInitStruct.TIM_Period = 999;
    TIM_TimeBaseInitStruct.TIM_Prescaler = 71;
    TIM_TimeBaseInitStruct.TIM_RepetitionCounter = 0;
    TIM_TimeBaseInit(TIM3, &TIM_TimeBaseInitStruct);

    // #1.3 开启ARR的预加载
    TIM_ARRPreloadConfig(TIM3, ENABLE);
    
    // #1.4 闭合时基单元的总开关
    TIM_Cmd(TIM3, ENABLE);

    // #2. 初始化输出比较的通道1
    // #2.1 初始化PA6
    GPIO_InitTypeDef GPIO_InitStruct = {0};
    
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);
    
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_6;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_AF_PP;
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_2MHz;
    GPIO_Init(GPIOA, &GPIO_InitStruct);

    // #2.2 配置OC1的参数
    TIM_OCInitTypeDef TIM_OCInitStruct = {0};
    
    TIM_OCInitStruct.TIM_OCMode = TIM_OCMode_PWM1;
    TIM_OCInitStruct.TIM_OCPolarity = TIM_OCPolarity_High;
    TIM_OCInitStruct.TIM_OutputState = ENABLE;
    TIM_OCInitStruct.TIM_Pulse = 0;
    
    TIM_OC1Init(TIM3, &TIM_OCInitStruct);

    // #2.3 使能MOE
    TIM_CtrlPWMOutputs(TIM3, ENABLE);

    // #2.4 使能CCRx的预加载
    TIM_CCPreloadControl(TIM3, ENABLE);
}
```

### 初始化时基单元
TIM1

![](/images/series/stm32/ch9/50.webp)

### 初始化输入捕获
### 初始化从模式控制器
### 测量PWM参数
#### 完整实验代码
```c
#include "stm32f10x.h"
#include "usart.h"
#include "delay.h"
#include <math.h>

void App_USART1_Init(void);
void App_TIM3_Init(void);
void App_TIM1_Init(void);

int main(void)
{
    App_USART1_Init();
    App_TIM3_Init();
    App_TIM1_Init();

    TIM_SetCompare1(TIM3, 200);		// 200/1000，即20%占空比
    
    while (1)
    {
        // #1. 清除Trigger标志位
        TIM_ClearFlag(TIM1, TIM_FLAG_Trigger);
        
        // #2. 等待Trigger标志位从0变为1
        while(TIM_GetFlagStatus(TIM1, TIM_FLAG_Trigger) == RESET);
        
        // #3. 计算
        uint16_t ccr1 = TIM_GetCapture1(TIM1);
        uint16_t ccr2 = TIM_GetCapture2(TIM1);
        
        float period = ccr1 * 1.0e-6f * 1.0e3f;
        float duty = ((float)ccr2) / ccr1 * 100.0f;

        My_USART_Printf(USART1, "周期=%.3fms, 占空比=%.2f%%\r\n", period, duty);

        Delay(100);
    }
}

void App_USART1_Init(void)
{
    // #1. 初始化IO引脚 PA9 AF_PP
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);

    GPIO_InitTypeDef GPIO_InitStruct = {0};
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_9;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_AF_PP;
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_10MHz;
    GPIO_Init(GPIOA, &GPIO_InitStruct);

    // #2.2 配置USART1的参数
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_USART1, ENABLE);
    USART_InitTypeDef USART_InitStruct = {0};
    
    USART_InitStruct.USART_BaudRate = 115200;
    USART_InitStruct.USART_HardwareFlowControl = USART_HardwareFlowControl_None;
    USART_InitStruct.USART_Mode = USART_Mode_Tx;
    USART_InitStruct.USART_Parity = USART_Parity_No;
    USART_InitStruct.USART_StopBits = USART_StopBits_1;
    USART_InitStruct.USART_WordLength = USART_WordLength_8b;
    
    USART_Init(USART1, &USART_InitStruct);
    
    // #2.3 闭合总开关
    USART_Cmd(USART1, ENABLE);
}

void App_TIM3_Init(void)
{
    // #1. 初始化时基单元
    // #1.1 开启TIM3的时钟
    RCC_APB1PeriphClockCmd(RCC_APB1Periph_TIM3, ENABLE);

    // #1.2 配置时基单元的参数
    TIM_TimeBaseInitTypeDef TIM_TimeBaseInitStruct = {0};

    TIM_TimeBaseInitStruct.TIM_CounterMode = TIM_CounterMode_Up;
    TIM_TimeBaseInitStruct.TIM_Period = 999;
    TIM_TimeBaseInitStruct.TIM_Prescaler = 71;
    TIM_TimeBaseInitStruct.TIM_RepetitionCounter = 0;
    TIM_TimeBaseInit(TIM3, &TIM_TimeBaseInitStruct);

    // #1.3 开启ARR的预加载
    TIM_ARRPreloadConfig(TIM3, ENABLE);
    
    // #1.4 闭合时基单元的总开关
    TIM_Cmd(TIM3, ENABLE);

    // #2. 初始化输出比较的通道1
    // #2.1 初始化PA6
    GPIO_InitTypeDef GPIO_InitStruct = {0};
    
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);
    
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_6;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_AF_PP;
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_2MHz;
    GPIO_Init(GPIOA, &GPIO_InitStruct);

    // #2.2 配置OC1的参数
    TIM_OCInitTypeDef TIM_OCInitStruct = {0};
    
    TIM_OCInitStruct.TIM_OCMode = TIM_OCMode_PWM1;
    TIM_OCInitStruct.TIM_OCPolarity = TIM_OCPolarity_High;
    TIM_OCInitStruct.TIM_OutputState = ENABLE;
    TIM_OCInitStruct.TIM_Pulse = 0;
    
    TIM_OC1Init(TIM3, &TIM_OCInitStruct);

    // #2.3 使能MOE
    TIM_CtrlPWMOutputs(TIM3, ENABLE);

    // #2.4 使能CCRx的预加载
    TIM_CCPreloadControl(TIM3, ENABLE);
}

void App_TIM1_Init(void)
{
    // #1. 配置时基单元
    // #1.1 开启定时器1的时钟
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_TIM1, ENABLE);

    // #1.2 配置时基单元的参数
    TIM_TimeBaseInitTypeDef TIM_TimeBaseInitStruct = {0};

    TIM_TimeBaseInitStruct.TIM_CounterMode = TIM_CounterMode_Up;
    TIM_TimeBaseInitStruct.TIM_Period = 65535;
    TIM_TimeBaseInitStruct.TIM_Prescaler = 71;
    TIM_TimeBaseInitStruct.TIM_RepetitionCounter = 0;
    TIM_TimeBaseInit(TIM1, &TIM_TimeBaseInitStruct);
 
    // #1.3 开启ARR的预加载
    TIM_ARRPreloadConfig(TIM1, ENABLE);
    
    // #1.4 闭合时基单元的总开关
    TIM_Cmd(TIM1, ENABLE);

    // #2. 初始化输入捕获
    // #2.1 初始化PA8引脚 IPD
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);
    
    GPIO_InitTypeDef GPIO_InitStruct = {0};
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_8;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_IPD;
    GPIO_Init(GPIOA, &GPIO_InitStruct);

    // #2.2 初始化输入捕获通道1
    TIM_ICInitTypeDef TIM_ICInitStruct = {0};
    
    TIM_ICInitStruct.TIM_Channel = TIM_Channel_1;
    TIM_ICInitStruct.TIM_ICFilter = 0;
    TIM_ICInitStruct.TIM_ICPolarity = TIM_ICPolarity_Rising;
    TIM_ICInitStruct.TIM_ICPrescaler = TIM_ICPSC_DIV1;
    TIM_ICInitStruct.TIM_ICSelection = TIM_ICSelection_DirectTI;
    TIM_ICInit(TIM1, &TIM_ICInitStruct);

    // #2.3 初始化输入捕获通道2
    TIM_ICInitStruct.TIM_Channel = TIM_Channel_2;
    TIM_ICInitStruct.TIM_ICFilter = 0;
    TIM_ICInitStruct.TIM_ICPolarity = TIM_ICPolarity_Falling;
    TIM_ICInitStruct.TIM_ICPrescaler = TIM_ICPSC_DIV1;
    TIM_ICInitStruct.TIM_ICSelection = TIM_ICSelection_IndirectTI;
    TIM_ICInit(TIM1, &TIM_ICInitStruct);

    // #3. 初始化从模式控制器
    TIM_SelectInputTrigger(TIM1, TIM_TS_TI1FP1);
    TIM_SelectSlaveMode(TIM1, TIM_SlaveMode_Reset); 
}
```
