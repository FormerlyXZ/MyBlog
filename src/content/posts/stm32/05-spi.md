---
title: "第五章 SPI：协议、按钮驱动与 W25Q64 实验"
description: "SPI 电路结构与协议、按钮驱动程序、IO 与 SPI 模块初始化、数据收发，以及 W25Q64 读写实验。"
date: 2026-10-25
image: "/images/series/stm32/ch5/01.webp"
categories: ["学习笔记"]
tags: ["STM32", "嵌入式", "学习笔记", "单片机"]
series: stm32
seriesOrder: 5
---
## 5.1 [SPI]电路结构和通信协议

### SPI 总线的电路结构
![](/images/series/stm32/ch5/01.webp)

#### NSS 引脚的作用（SPI 通信场景）
NSS（**Negative Slave Select**，也常叫 CS/Chip Select，片选）是 SPI 通信中**从机选择**的关键信号，核心作用如下：

##### 1. 选中目标从机
+ SPI 总线是**共享总线**（MOSI/MISO/SCK 所有从机共用），主机通过**拉低对应从机的 NSS 引脚**，来指定本次通信要和哪一个从机交互。
+ 只有 NSS 被拉低的从机才会被激活，响应主机的读写指令；其他 NSS 为高电平的从机处于**高阻态 / 休眠状态**，不会干扰总线。
+ 如图中：主机要和「从机 2」通信时，只需要拉低从机 2 的 NSS，从机 1、从机 3 的 NSS 保持高电平即可。

##### 2. 界定通信边界
+ **拉低 NSS**：标志一次 SPI 通信的**开始**，从机开始监听总线数据。
+ **拉高 NSS**：标志本次通信的**结束**，从机复位状态，等待下一次被选中。
+ 它相当于给每帧数据加上「开始 / 结束标记」，避免多帧数据混淆。

##### 3. 防止总线冲突
未被选中的从机，其 MISO（主收从发）引脚会进入高阻态，不会向总线输出数据，避免多个从机同时发送导致总线电平冲突。

### 通信流程及波形
![](/images/series/stm32/ch5/02.webp)

### 参数1：时钟信号的极性及相位
![](/images/series/stm32/ch5/03.webp)

![](/images/series/stm32/ch5/04.webp)

### SPI 的4种模式
![](/images/series/stm32/ch5/05.webp)

### 参数2：传输顺序
![](/images/series/stm32/ch5/06.webp)

### 参数3：数据宽度
![](/images/series/stm32/ch5/07.webp)

## 5.2 [番外]按钮驱动程序编写

### 连接电路
![](/images/series/stm32/ch5/08.webp)

![](/images/series/stm32/ch5/09.webp)

![](/images/series/stm32/ch5/10.webp)

### 初始化板载LED和按钮
#### 封装函数
```c
void App_Button_Init(void);
void App_OnBoardLED_Init(void);

void App_Button_Init(void)
{
    // PA0
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);

    GPIO_InitTypeDef GPIO_InitStruct;

    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_0;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_IPU;

    GPIO_Init(GPIOA, &GPIO_InitStruct);
}

void App_OnBoardLED_Init(void)
{
    // PC13
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOC, ENABLE);
    
    GPIO_InitTypeDef GPIO_InitStruct;
    
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_13;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_Out_OD;
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_2MHz;
    
    GPIO_Init(GPIOC, &GPIO_InitStruct);
}
```

### 按钮程序的基本原理
![](/images/series/stm32/ch5/11.webp)

#### GPIO_ReadOutputDataBit
```c
uint8_t GPIO_ReadOutputDataBit(GPIO_TypeDef *GPIOx, uint16_t GPIO_Pin);
```

**作用**：读取指定 GPIO 端口输出数据寄存器（ODR）的某一个比特位，返回该引脚当前的输出电平状态。  

#### 实验代码
```c
#include "stm32f10x.h"

void App_Button_Init(void);
void App_OnBoardLED_Init(void);

int main(void)
{	
    App_Button_Init();    // 按钮初始化
    App_OnBoardLED_Init(); // LED初始化

    uint8_t current = Bit_SET, previous = Bit_RESET;
    
    while(1)
    {
      previous = current;
    
      current = GPIO_ReadInputDataBit(GPIOA, GPIO_Pin_0);
    
      if(current != previous)
      {
        if(current == Bit_SET)
        {
          // 改变LED
          if(GPIO_ReadOutputDataBit(GPIOC, GPIO_Pin_13) == Bit_SET)
          {
            GPIO_WriteBit(GPIOC, GPIO_Pin_13, Bit_RESET);
          }
          else
          {
            GPIO_WriteBit(GPIOC, GPIO_Pin_13, Bit_SET);
          }
        }
        else
        {
        }
      }
    }
}

void App_Button_Init(void)
{
    // PA0
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);

    GPIO_InitTypeDef GPIO_InitStruct;

    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_0;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_IPU;

    GPIO_Init(GPIOA, &GPIO_InitStruct);
}

void App_OnBoardLED_Init(void)
{
    // PC13
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOC, ENABLE);
    
    GPIO_InitTypeDef GPIO_InitStruct;
    
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_13;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_Out_OD;
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_2MHz;
    
    GPIO_Init(GPIOC, &GPIO_InitStruct);
}
```

### 按钮消抖的原理
![](/images/series/stm32/ch5/12.webp)

完整实验代码

```c
#include "stm32f10x.h"
#include "Delay.h"

void App_Button_Init(void);
void App_OnBoardLED_Init(void);

int main(void)
{	
    App_Button_Init();    // 按钮初始化
    App_OnBoardLED_Init(); // LED初始化

    uint8_t current = Bit_SET, previous = Bit_RESET;
    
    while(1)
    {
      previous = current;
    
      current = GPIO_ReadInputDataBit(GPIOA, GPIO_Pin_0);
    
      if(current != previous)
      {
        if(current == Bit_SET)
        {
          // 改变LED
          if(GPIO_ReadOutputDataBit(GPIOC, GPIO_Pin_13) == Bit_SET)
          {
            GPIO_WriteBit(GPIOC, GPIO_Pin_13, Bit_RESET);
          }
          else
          {
            GPIO_WriteBit(GPIOC, GPIO_Pin_13, Bit_SET);
          }
        }
        else
        {
        }
        Delay(10);
      }
    }
}

void App_Button_Init(void)
{
    // PA0
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);

    GPIO_InitTypeDef GPIO_InitStruct;

    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_0;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_IPU;

    GPIO_Init(GPIOA, &GPIO_InitStruct);
}

void App_OnBoardLED_Init(void)
{
    // PC13
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOC, ENABLE);
    
    GPIO_InitTypeDef GPIO_InitStruct;
    
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_13;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_Out_OD;
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_2MHz;
    
    GPIO_Init(GPIOC, &GPIO_InitStruct);
}
```

## 5.3 [番外]按钮代码的封装

### 搭建电路

![](/images/series/stm32/ch5/13.webp)

### 串口的初始化

#### 实验代码

```c
#include "stm32f10x.h"
#include "usart.h"

void App_USART1_Init(void);

int main(void)
{
    App_USART1_Init();
    My_USART_SendString(USART1, "Hello world.\r\n");
    
    while(1)
    {
    }
}

void App_USART1_Init(void)
{
    // #1. 初始化IO引脚 PA9 Tx P10 Rx
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);
    
    GPIO_InitTypeDef GPIO_InitStruct;
    
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_9;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_AF_PP;
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_2MHz;
    GPIO_Init(GPIOA, &GPIO_InitStruct);
    
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_10;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_IPU;
    GPIO_Init(GPIOA, &GPIO_InitStruct);

    // #2. 初始化USART1
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_USART1, ENABLE);
    
    USART_InitTypeDef USART_InitStruct;
    USART_InitStruct.USART_BaudRate = 115200;
    USART_InitStruct.USART_Mode = USART_Mode_Tx | USART_Mode_Rx;
    USART_InitStruct.USART_WordLength = USART_WordLength_8b;
    USART_InitStruct.USART_Parity = USART_Parity_No;
    USART_InitStruct.USART_StopBits = USART_StopBits_1;
    USART_Init(USART1, &USART_InitStruct);

    USART_Cmd(USART1, ENABLE);
}
```

### 按钮的初始化

#### My_Button_Init

```c
void My_Button_Init(Button_TypeDef *Button, Button_InitTypeDef *Button_InistStruct);
```

**作用**：初始化按钮（包括 IO 引脚的初始化）

```c
struct GPIO_InitTypeDef {
    GPIO_TypeDef *GPIOx;          // IO引脚的端口号（如GPIOA、GPIOB）
    uint16_t GPIO_Pin;            // IO引脚的编号（如GPIO_Pin_0）
    uint32_t LongPressTime;       // 长按时间阈值（单位：ms），0表示默认值1000ms
    uint32_t LongPressInterval;   // 长按后持续触发的时间间隔（单位：ms），0表示默认值100ms
    uint32_t ClickInterval;        // 连击的最大时间间隔（单位：ms），0表示默认值200ms

    // 回调函数指针，未使用时填0
    void (*button_pressed_cb)(void);    // 按钮按下时的回调函数
    void (*button_released_cb)(void);   // 按钮抬起时的回调函数
    void (*button_clicked_cb)(uint8_t clicks); // 按钮点击时的回调函数（参数为连击次数）
    void (*button_long_pressed_cb)(uint8_t ticks); // 按钮长按时的回调函数（参数为长按触发次数）
};
```

***

##### 接口说明

* <code>**My_Button_Init**</code>：接收按钮实例指针和配置结构体指针，完成按钮硬件初始化（含 GPIO）与事件回调绑定。
* **配置结构体**：通过配置长按阈值、连击间隔等参数，配合回调函数，可实现**单击、连击、长按**等复杂按钮事件处理，无需在主循环中手动轮询判断。

### 进程函数

#### My_Button_Proc

```c
void My_Button_Proc(Button_TypeDef *Button); // 按钮进程函数（负责检测与事件处理）
```

```c
int main(void) {
    // 1. 按钮初始化（包含IO引脚+参数+回调配置）
    My_Button_Init(...); 

    while(1) {
        // 2. 按钮状态检测与事件处理（替代手动轮询逻辑）
        My_Button_Proc(&button1); 
    }
}
```

#### 接口说明

* **核心作用**：将原来手动编写的「保存上次状态→读取当前电平→判断跳变→执行动作」逻辑封装起来，在主循环中调用即可自动完成：
  * 按键消抖
  * 单击 / 长按 / 连击等事件判断
  * 触发预先绑定的回调函数（如<code>button_clicked_cb</code>、<code>button_pressed_cb</code>等）
* **优势**：主循环代码更简洁，按钮逻辑复用性更强，避免重复编写按键检测代码。

### 回调函数

#### 完整实验代码

```c
#include "stm32f10x.h"
#include "usart.h"
#include "button.h"

Button_TypeDef button1;
uint32_t cnt = 0;

void App_USART1_Init(void);
void App_Button_Init(void);
void button_clicked_cb(uint8_t clicks);
void button_long_pressed_cb(uint8_t ticks);

int main(void)
{
    App_USART1_Init();
    App_Button_Init();
    
    while(1)
    {
        My_Button_Proc(&button1);
    }
}

void App_USART1_Init(void)
{
    // #1. 初始化IO引脚 PA9 Tx P10 Rx
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);
    
    GPIO_InitTypeDef GPIO_InitStruct;
    
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_9;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_AF_PP;
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_2MHz;
    GPIO_Init(GPIOA, &GPIO_InitStruct);
    
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_10;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_IPU;
    GPIO_Init(GPIOA, &GPIO_InitStruct);

    // #2. 初始化USART1
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_USART1, ENABLE);
    
    USART_InitTypeDef USART_InitStruct;
    USART_InitStruct.USART_BaudRate = 115200;
    USART_InitStruct.USART_Mode = USART_Mode_Tx | USART_Mode_Rx;
    USART_InitStruct.USART_WordLength = USART_WordLength_8b;
    USART_InitStruct.USART_Parity = USART_Parity_No;
    USART_InitStruct.USART_StopBits = USART_StopBits_1;
    USART_Init(USART1, &USART_InitStruct);

    USART_Cmd(USART1, ENABLE);
}

void App_Button_Init(void)
{
    Button_InitTypeDef Button_InitStruct;

    Button_InitStruct.GPIOx = GPIOA;
    Button_InitStruct.GPIO_Pin = GPIO_Pin_0;
    Button_InitStruct.ClickInterval = 0;
    Button_InitStruct.LongPressTime = 0;
    Button_InitStruct.LongPressTickInterval = 0;
    Button_InitStruct.button_clicked_cb = button_clicked_cb;
    Button_InitStruct.button_pressed_cb = 0;
    Button_InitStruct.button_released_cb = 0;
    Button_InitStruct.button_long_pressed_cb = button_long_pressed_cb;
    
    My_Button_Init(&button1, &Button_InitStruct);
}

void button_clicked_cb(uint8_t clicks)
{
    if(clicks == 1)
    {
        cnt++;
        My_USART_Printf(USART1, "%d", cnt);
    }
    else if(clicks == 2)
    {
        cnt = 0;
        My_USART_Printf(USART1, "%d", cnt);
    }
}

void button_long_pressed_cb(uint8_t ticks)
{
    cnt++;
    My_USART_Printf(USART1, "%d", cnt);
}
```

## 5.4 [SPI]IO引脚初始化

### SPI 模块简介
![](/images/series/stm32/ch2/01.webp)

### W25Q64 简介
![](/images/series/stm32/ch5/15.webp)

![](/images/series/stm32/ch5/16.webp)

### 定位SPI引脚位置
![](/images/series/stm32/ch5/17.webp)

![](/images/series/stm32/ch5/18.webp)

### 选择IO引脚的模式
![](/images/series/stm32/ch5/19.webp)

### 选择IO的最大输出速度
![](/images/series/stm32/ch5/20.webp)

![](/images/series/stm32/ch5/21.webp)

#### 完整实验代码
```c
#include "stm32f10x.h"

void App_SPI1_Init(void);

int main(void)
{
    App_SPI1_Init();

    while(1)
    {
    }
}

void App_SPI1_Init(void)
{
    // #1. 初始化IO引脚
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_AFIO, ENABLE);
    GPIO_PinRemapConfig(GPIO_Remap_SPI1, ENABLE);

    GPIO_InitTypeDef GPIO_InitStruct;

    // PB3 SCK AF_PP 2MHz // PB5 MOSI
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOB, ENABLE);
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_3 | GPIO_Pin_5;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_AF_PP;
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_2MHz;
    GPIO_Init(GPIOB, &GPIO_InitStruct);

    // PB4 MISO IPU
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOB, ENABLE);
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_4;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_IPU;
    GPIO_Init(GPIOB, &GPIO_InitStruct);

    // PA15 普通IO Out_PP 2MHz
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_15;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_Out_PP;
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_2MHz;
    GPIO_Init(GPIOA, &GPIO_InitStruct);
}
```

## 5.5 [SPI]SPI模块初始化

### SPI 模块的基本工作原理
![](/images/series/stm32/ch5/22.webp)

### SPI_Init
#### 函数声明
```c
void SPI_Init(SPI_TypeDef *SPIx,        // SPI的名称，可以是SPI1或SPI2
              SPI_InitTypeDef *SPI_InitStruct); // 用于传递初始化参数
```

**作用**：对 SPI 模块进行初始化  

####  初始化参数结构体  
```c
struct SPI_InitTypeDef{
    uint16_t SPI_Direction;        // 用来选择SPI通信的方向
    uint16_t SPI_Mode;             // 用来选择SPI的模式，SPI_Master - 主机，SPI_Slave - 从机
    uint16_t SPI_DataSize;         // 数据宽度，SPI_DataSize_8b - 8bit，SPI_DataSize_16b - 16bit
    uint16_t SPI_CPOL;             // 时钟的极性
    uint16_t SPI_CPHA;             // 时钟的相位
    uint16_t SPI_NSS;              // 软件NSS/硬件NSS
    uint16_t SPI_BaudRatePrescaler;// 用来选择波特率分频器的分频系数
    uint16_t SPI_FirstBit;         // 比特位的传输顺序，SPI_FirstBit_MSB（高位优先）
};
```

### 选择数据通信方向
![](/images/series/stm32/ch5/23.webp)

### 数据宽度、极性、相位和比特位传输顺序
![](/images/series/stm32/ch5/24.webp)

![](/images/series/stm32/ch5/25.webp)

![](/images/series/stm32/ch5/26.webp)

### 设置波特率
![](/images/series/stm32/ch5/27.webp)

![](/images/series/stm32/ch5/28.webp)

### NSS 的配置方式
![](/images/series/stm32/ch5/29.webp)

#### 完整实验代码
```c
#include "stm32f10x.h"

void App_SPI1_Init(void);

int main(void)
{
    App_SPI1_Init();

    while(1)
    {
    }
}

void App_SPI1_Init(void)
{
    // #1. 初始化IO引脚
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_AFIO, ENABLE);
    GPIO_PinRemapConfig(GPIO_Remap_SPI1, ENABLE);
    GPIO_PinRemapConfig(GPIO_Remap_SWJ_JTAGDisable, ENABLE);

    GPIO_InitTypeDef GPIO_InitStruct;

    // PB3 SCK AF_PP 2MHz // PB5 MOSI
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOB, ENABLE);
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_3 | GPIO_Pin_5;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_AF_PP;
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_2MHz;
    GPIO_Init(GPIOB, &GPIO_InitStruct);

    // PB4 MISO IPU
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOB, ENABLE);
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_4;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_IPU;
    GPIO_Init(GPIOB, &GPIO_InitStruct);

    // PA15 普通IO Out_PP 2MHz
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_15;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_Out_PP;
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_2MHz;
    GPIO_Init(GPIOA, &GPIO_InitStruct);
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_RESET);

    // #2. 对SPI本身进行初始化
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_SPI1, ENABLE);
    
    SPI_InitTypeDef SPI_InitStruct;

    SPI_InitStruct.SPI_Mode = SPI_Mode_Master;
    SPI_InitStruct.SPI_Direction = SPI_Direction_2Lines_FullDuplex;
    SPI_InitStruct.SPI_DataSize = SPI_DataSize_8b;	// 传输长度为8
    SPI_InitStruct.SPI_CPOL = SPI_CPOL_Low;	// 极性低，不支持mode3
    SPI_InitStruct.SPI_CPHA = SPI_CPHA_1Edge;	// 第一边沿采集
    SPI_InitStruct.SPI_FirstBit = SPI_FirstBit_MSB;	// MSB
    SPI_InitStruct.SPI_BaudRatePrescaler = SPI_BaudRatePrescaler_64;

    SPI_InitStruct.SPI_NSS = SPI_NSS_Soft;
    SPI_Init(SPI1, &SPI_InitStruct);
    SPI_NSSInternalSoftwareConfig(SPI1, SPI_NSSInternalSoft_Set);
}
```

## 5.6 [SPI]数据收发

###  SPI 数据收发的特点
![](/images/series/stm32/ch5/30.webp)

### 声明数据收发的编程接口
#### pp_SPI_MasterTransmitReceive
```c
void App_SPI_MasterTransmitReceive(SPITypeDef *SPIx,    // SPI的名称
                                    const uint8_t *pDataTx, // 要发送的数据
                                    uint8_t *pDataRx, // 接收到的数据
                                    uint16_t Size);  // 收发数据的数量
```

 作用：使用 SPI 总线收发数据

### SPI 数据收发过程简介
![](/images/series/stm32/ch5/31.webp)

![](/images/series/stm32/ch5/32.webp)

### 代码编写
#### 完整实验代码
```c
#include "stm32f10x.h"

void App_SPI1_Init(void);
void App_SPI_MasterTransmitReceive(SPI_TypeDef *SPIx,    // SPI的名称
                                    const uint8_t *pDataTx, // 要发送的数据
                                    uint8_t *pDataRx, // 接收到的数据
                                    uint16_t Size);  // 收发数据的数量

int main(void)
{
    App_SPI1_Init();

    while(1)
    {
    }
}

void App_SPI1_Init(void)
{
    // #1. 初始化IO引脚
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_AFIO, ENABLE);
    GPIO_PinRemapConfig(GPIO_Remap_SPI1, ENABLE);
    GPIO_PinRemapConfig(GPIO_Remap_SWJ_JTAGDisable, ENABLE);

    GPIO_InitTypeDef GPIO_InitStruct;

    // PB3 SCK AF_PP 2MHz // PB5 MOSI
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOB, ENABLE);
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_3 | GPIO_Pin_5;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_AF_PP;
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_2MHz;
    GPIO_Init(GPIOB, &GPIO_InitStruct);

    // PB4 MISO IPU
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOB, ENABLE);
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_4;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_IPU;
    GPIO_Init(GPIOB, &GPIO_InitStruct);

    // PA15 普通IO Out_PP 2MHz
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_15;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_Out_PP;
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_2MHz;
    GPIO_Init(GPIOA, &GPIO_InitStruct);
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_RESET);

    // #2. 对SPI本身进行初始化
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_SPI1, ENABLE);
    
    SPI_InitTypeDef SPI_InitStruct;

    SPI_InitStruct.SPI_Mode = SPI_Mode_Master;
    SPI_InitStruct.SPI_Direction = SPI_Direction_2Lines_FullDuplex;
    SPI_InitStruct.SPI_DataSize = SPI_DataSize_8b;	// 传输长度为8
    SPI_InitStruct.SPI_CPOL = SPI_CPOL_Low;	// 极性低，不支持mode3
    SPI_InitStruct.SPI_CPHA = SPI_CPHA_1Edge;	// 第一边沿采集
    SPI_InitStruct.SPI_FirstBit = SPI_FirstBit_MSB;	// MSB
    SPI_InitStruct.SPI_BaudRatePrescaler = SPI_BaudRatePrescaler_64;

    SPI_InitStruct.SPI_NSS = SPI_NSS_Soft;
    SPI_Init(SPI1, &SPI_InitStruct);
    SPI_NSSInternalSoftwareConfig(SPI1, SPI_NSSInternalSoft_Set);
}

void App_SPI_MasterTransmitReceive(SPI_TypeDef *SPIx,    // SPI的名称
                                    const uint8_t *pDataTx, // 要发送的数据
                                    uint8_t *pDataRx, // 接收到的数据
                                    uint16_t Size)  // 收发数据的数量
{
    SPI_Cmd(SPIx, ENABLE); // #1. 闭合总开关（使能SPI）
    SPI_I2S_SendData(SPIx, pDataTx[0]); // #2. 发送第一个字节

    // #3. 循环收发 Size-1 次数据
    for(uint16_t i=0; i<Size-1; i++)
    {
        // 发送一个字节：等待发送缓冲区空（TXE）
        while(SPI_I2S_GetFlagStatus(SPIx, SPI_I2S_FLAG_TXE) == RESET);
        SPI_I2S_SendData(SPIx, pDataTx[i+1]);
        
        // 接收一个字节：等待接收缓冲区非空（RXNE）
        while(SPI_I2S_GetFlagStatus(SPIx, SPI_I2S_FLAG_RXNE) == RESET);
        pDataRx[i] = SPI_I2S_ReceiveData(SPIx);
    }
    
    // #4. 读出最后一个字节
    while(SPI_I2S_GetFlagStatus(SPIx, SPI_I2S_FLAG_RXNE) == RESET);
    pDataRx[Size-1] = SPI_I2S_ReceiveData(SPIx);
    
    // #5. 断开总开关（失能SPI）
    SPI_Cmd(SPIx, DISABLE);
}
```

## 5.7 [SPI]W25Q64实验（上）

### W25Q64 的存储结构
![](/images/series/stm32/ch5/33.webp)

存储模块，存储数据掉电不丢失

### 使用 W25Q64 存储数据
![](/images/series/stm32/ch5/34.webp)

##### 一、基本容量与结构
+ **总容量**：64Mbit（即 8MByte）
+ **层级划分**：
    - 块（Block）：64kByte，芯片共 **128 个块**
    - 扇区（Sector）：4kByte，每个块包含 **16 个扇区**
    - 页（Page）：256Byte，每个扇区包含 **16 个页**

##### 二、写操作流程
1. **扇区擦除流程**：写使能 → 扇区擦除 → 等待空闲
2. **页编程流程**：写使能 → 页编程 → 等待空闲

![](/images/series/stm32/ch5/35.webp)

![](/images/series/stm32/ch5/36.webp)

![](/images/series/stm32/ch5/37.webp)

#### App_W25Q64_SaveByte
```c
void App_W25Q64_SaveByte(uint8_t Byte); // 使用W25Q64保存一个字节

void App_W25Q64_SaveByte(uint8_t Byte)
{
    uint8_t buffer[10];

    // #1. 写使能
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_RESET); // 选中
    App_SPI_MasterTransmitReceive(SPI1, buffer, buffer, 1);
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_SET);   // 取消选中

    // #2. 扇区擦除（指令0x20 + 24位地址）
    buffer[0] = 0x20; // 扇区擦除指令
    buffer[1] = 0x00; // 地址高位（A23~A16）
    buffer[2] = 0x00; // 地址中位（A15~A8）
    buffer[3] = 0x00; // 地址低位（A7~A0）
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_RESET); // 选中芯片
    App_SPI_MasterTransmitReceive(SPI1, buffer, buffer, 4);
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_SET);   // 取消选中

    // #3. 等待空闲
    while(1)
    {
        GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_RESET); // 选中
        
        // 写0x05（读状态寄存器指令）
        buffer[0] = 0x05;
        App_SPI_MasterTransmitReceive(SPI1, buffer, buffer, 1);
        
        // 读状态寄存器1
        buffer[0] = 0xff;
        App_SPI_MasterTransmitReceive(SPI1, buffer, buffer, 1);
        
        GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_SET); // 取消选中
        if((buffer[0] & 0x01) == 0) break;
    }

    // #4. 写使能
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_RESET); // 选中
    App_SPI_MasterTransmitReceive(SPI1, buffer, buffer, 1);
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_SET);   // 取消选中
    
    // #5. 页编程
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_RESET); // 选中
    buffer[0] = 0x02;
    buffer[1] = 0x00;
    buffer[2] = 0x00;
    buffer[3] = 0x00;
    buffer[4] = Byte;
    App_SPI_MasterTransmitReceive(SPI1, buffer, buffer, 5);
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_SET);   // 取消选中

    // #6. 等待空闲
    while(1)
    {
        GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_RESET); // 选中
        
        // 写0x05（读状态寄存器指令）
        buffer[0] = 0x05;
        App_SPI_MasterTransmitReceive(SPI1, buffer, buffer, 1);
        
        // 读状态寄存器1
        buffer[0] = 0xff;
        App_SPI_MasterTransmitReceive(SPI1, buffer, buffer, 1);
        
        GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_SET); // 取消选中
        if((buffer[0] & 0x01) == 0) break;
    }
}
```

### 使用 W25Q64 读取数据
![](/images/series/stm32/ch5/38.webp)

#### App_W25Q64_LoadByte
```c
uint8_t App_W25Q64_LoadByte(void);      // 把保存的字节读出来

uint8_t App_W25Q64_LoadByte(void)
{
    uint8_t buffer[10];

    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_RESET); // 选中
    buffer[0] = 0x03;
    buffer[1] = 0x00;
    buffer[2] = 0x00;
    buffer[3] = 0x00;
    
    App_SPI_MasterTransmitReceive(SPI1, buffer, buffer, 4);
    
    buffer[0] = 0xff;
    App_SPI_MasterTransmitReceive(SPI1, buffer, buffer, 1);
    
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_SET); // 取消选中
    
    return buffer[0];
}
```

#### 完整实验代码
```c
#include "stm32f10x.h"
#include "delay.h"

uint8_t a = 0;

void App_SPI1_Init(void);
void App_SPI_MasterTransmitReceive(SPI_TypeDef *SPIx,    // SPI的名称
                                    const uint8_t *pDataTx, // 要发送的数据
                                    uint8_t *pDataRx, // 接收到的数据
                                    uint16_t Size);  // 收发数据的数量
void App_W25Q64_SaveByte(uint8_t Byte);
uint8_t App_W25Q64_LoadByte(void);

int main(void)
{
    App_SPI1_Init();

    App_W25Q64_SaveByte(0x12);
    a = App_W25Q64_LoadByte();

    while(1)
    {
    }
}

void App_SPI1_Init(void)
{
    // #1. 初始化IO引脚
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_AFIO, ENABLE);
    GPIO_PinRemapConfig(GPIO_Remap_SPI1, ENABLE);
    GPIO_PinRemapConfig(GPIO_Remap_SWJ_JTAGDisable, ENABLE);

    GPIO_InitTypeDef GPIO_InitStruct;

    // PB3 SCK AF_PP 2MHz // PB5 MOSI
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOB, ENABLE);
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_3 | GPIO_Pin_5;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_AF_PP;
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_2MHz;
    GPIO_Init(GPIOB, &GPIO_InitStruct);

    // PB4 MISO IPU
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOB, ENABLE);
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_4;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_IPU;
    GPIO_Init(GPIOB, &GPIO_InitStruct);

    // PA15 普通IO Out_PP 2MHz
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_15;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_Out_PP;
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_2MHz;
    GPIO_Init(GPIOA, &GPIO_InitStruct);
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_RESET);

    // #2. 对SPI本身进行初始化
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_SPI1, ENABLE);
    
    SPI_InitTypeDef SPI_InitStruct;

    SPI_InitStruct.SPI_Mode = SPI_Mode_Master;
    SPI_InitStruct.SPI_Direction = SPI_Direction_2Lines_FullDuplex;
    SPI_InitStruct.SPI_DataSize = SPI_DataSize_8b;	// 传输长度为8
    SPI_InitStruct.SPI_CPOL = SPI_CPOL_Low;	// 极性低，不支持mode3
    SPI_InitStruct.SPI_CPHA = SPI_CPHA_1Edge;	// 第一边沿采集
    SPI_InitStruct.SPI_FirstBit = SPI_FirstBit_MSB;	// MSB
    SPI_InitStruct.SPI_BaudRatePrescaler = SPI_BaudRatePrescaler_64;

    SPI_InitStruct.SPI_NSS = SPI_NSS_Soft;
    SPI_Init(SPI1, &SPI_InitStruct);
    SPI_NSSInternalSoftwareConfig(SPI1, SPI_NSSInternalSoft_Set);
}

void App_SPI_MasterTransmitReceive(SPI_TypeDef *SPIx,    // SPI的名称
                                    const uint8_t *pDataTx, // 要发送的数据
                                    uint8_t *pDataRx, // 接收到的数据
                                    uint16_t Size)  // 收发数据的数量
{
    SPI_Cmd(SPIx, ENABLE); // #1. 闭合总开关（使能SPI）
    SPI_I2S_SendData(SPIx, pDataTx[0]); // #2. 发送第一个字节

    // #3. 循环收发 Size-1 次数据
    for(uint16_t i=0; i<Size-1; i++)
    {
        // 发送一个字节：等待发送缓冲区空（TXE）
        while(SPI_I2S_GetFlagStatus(SPIx, SPI_I2S_FLAG_TXE) == RESET);
        SPI_I2S_SendData(SPIx, pDataTx[i+1]);
        
        // 接收一个字节：等待接收缓冲区非空（RXNE）
        while(SPI_I2S_GetFlagStatus(SPIx, SPI_I2S_FLAG_RXNE) == RESET);
        pDataRx[i] = SPI_I2S_ReceiveData(SPIx);
    }
    
    // #4. 读出最后一个字节
    while(SPI_I2S_GetFlagStatus(SPIx, SPI_I2S_FLAG_RXNE) == RESET);
    pDataRx[Size-1] = SPI_I2S_ReceiveData(SPIx);
    
    // #5. 断开总开关（失能SPI）
    SPI_Cmd(SPIx, DISABLE);
}

void App_W25Q64_SaveByte(uint8_t Byte)
{
    uint8_t buffer[10];

    // #1. 写使能
    buffer[0] = 0x06;
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_RESET); // 选中
    App_SPI_MasterTransmitReceive(SPI1, buffer, buffer, 1);
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_SET);   // 取消选中

    // #2. 扇区擦除（指令0x20 + 24位地址）
    buffer[0] = 0x20; // 扇区擦除指令
    buffer[1] = 0x00; // 地址高位（A23~A16）
    buffer[2] = 0x00; // 地址中位（A15~A8）
    buffer[3] = 0x00; // 地址低位（A7~A0）
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_RESET); // 选中芯片
    App_SPI_MasterTransmitReceive(SPI1, buffer, buffer, 4);
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_SET);   // 取消选中

    // #3. 等待空闲
    while(1)
    {
        GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_RESET); // 选中
        
        // 写0x05（读状态寄存器指令）
        buffer[0] = 0x05;
        App_SPI_MasterTransmitReceive(SPI1, buffer, buffer, 1);
        
        // 读状态寄存器1
        buffer[0] = 0xff;
        App_SPI_MasterTransmitReceive(SPI1, buffer, buffer, 1);
        
        GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_SET); // 取消选中
        if((buffer[0] & 0x01) == 0) break;
    }

    // #4. 写使能
    buffer[0] = 0x06;
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_RESET); // 选中
    App_SPI_MasterTransmitReceive(SPI1, buffer, buffer, 1);
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_SET);   // 取消选中
    
    // #5. 页编程
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_RESET); // 选中
    buffer[0] = 0x02;
    buffer[1] = 0x00;
    buffer[2] = 0x00;
    buffer[3] = 0x00;
    buffer[4] = Byte;
    App_SPI_MasterTransmitReceive(SPI1, buffer, buffer, 5);
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_SET);   // 取消选中

    // #6. 等待空闲
    while(1)
    {
        GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_RESET); // 选中
        
        // 写0x05（读状态寄存器指令）
        buffer[0] = 0x05;
        App_SPI_MasterTransmitReceive(SPI1, buffer, buffer, 1);
        
        // 读状态寄存器1
        buffer[0] = 0xff;
        App_SPI_MasterTransmitReceive(SPI1, buffer, buffer, 1);
        
        GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_SET); // 取消选中
        if((buffer[0] & 0x01) == 0) break;
    }
}

uint8_t App_W25Q64_LoadByte(void)
{
    uint8_t buffer[10];

    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_RESET); // 选中
    buffer[0] = 0x03;
    buffer[1] = 0x00;
    buffer[2] = 0x00;
    buffer[3] = 0x00;
    
    App_SPI_MasterTransmitReceive(SPI1, buffer, buffer, 4);
    
    buffer[0] = 0xff;
    App_SPI_MasterTransmitReceive(SPI1, buffer, buffer, 1);
    
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_SET); // 取消选中
    
    return buffer[0];
}
```

## 5.8 [SPI]W25Q64实验（下）

###  初始化板载 LED
![](/images/series/stm32/ch5/39.webp)

#### App_OnBoardLED_Init
```c
void App_OnBoardLED_Init(void);

void App_OnBoardLED_Init(void)
{
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOC, ENABLE);

    GPIO_InitTypeDef GPIO_InitStruct;
    
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_13;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_Out_OD;
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_2MHz;
    GPIO_Init(GPIOC, &GPIO_InitStruct);
}
```

### 初始化按钮使用按钮切换
#### App_Button_Init
```c
void App_Button_Init(void);

void App_Button_Init(void)
{
    Button_InitTypeDef Button_InitStruct = {0};

    Button_InitStruct.GPIOx = GPIOA;
    Button_InitStruct.GPIO_Pin = GPIO_Pin_0;
    Button_InitStruct.button_clicked_cb = button_clicked_cb;
    
    My_Button_Init(&button, &Button_InitStruct);
}
```

#### button_clicked_cb
```c
void button_clicked_cb(uint8_t clicks;

void button_clicked_cb(uint8_t clicks)
{
    if(clicks == 1)
    {
      if(GPIO_ReadOutputDataBit(GPIOC, GPIO_Pin_13) == Bit_SET)
      {
        GPIO_WriteBit(GPIOC, GPIO_Pin_13, Bit_RESET);
      }
      else
      {
        GPIO_WriteBit(GPIOC, GPIO_Pin_13, Bit_SET);
      }
    }
}
```

### LED 的亮灭
#### 实验代码
```c
#include "stm32f10x.h"
#include "delay.h"
#include "button.h"

Button_TypeDef button;

void App_SPI1_Init(void);
void App_SPI_MasterTransmitReceive(SPI_TypeDef *SPIx,    // SPI的名称
                                    const uint8_t *pDataTx, // 要发送的数据
                                    uint8_t *pDataRx, // 接收到的数据
                                    uint16_t Size);  // 收发数据的数量
void App_W25Q64_SaveByte(uint8_t Byte);
uint8_t App_W25Q64_LoadByte(void);
void App_OnBoardLED_Init(void);
void App_Button_Init(void);
void button_clicked_cb(uint8_t clicks);

int main(void)
{
    App_SPI1_Init();
    App_OnBoardLED_Init();
    App_Button_Init();

    while(1)
    {
        My_Button_Proc(&button);
    }
}

void App_SPI1_Init(void)
{
    // #1. 初始化IO引脚
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_AFIO, ENABLE);
    GPIO_PinRemapConfig(GPIO_Remap_SPI1, ENABLE);
    GPIO_PinRemapConfig(GPIO_Remap_SWJ_JTAGDisable, ENABLE);

    GPIO_InitTypeDef GPIO_InitStruct;

    // PB3 SCK AF_PP 2MHz // PB5 MOSI
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOB, ENABLE);
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_3 | GPIO_Pin_5;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_AF_PP;
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_2MHz;
    GPIO_Init(GPIOB, &GPIO_InitStruct);

    // PB4 MISO IPU
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOB, ENABLE);
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_4;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_IPU;
    GPIO_Init(GPIOB, &GPIO_InitStruct);

    // PA15 普通IO Out_PP 2MHz
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_15;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_Out_PP;
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_2MHz;
    GPIO_Init(GPIOA, &GPIO_InitStruct);
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_RESET);

    // #2. 对SPI本身进行初始化
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_SPI1, ENABLE);
    
    SPI_InitTypeDef SPI_InitStruct;

    SPI_InitStruct.SPI_Mode = SPI_Mode_Master;
    SPI_InitStruct.SPI_Direction = SPI_Direction_2Lines_FullDuplex;
    SPI_InitStruct.SPI_DataSize = SPI_DataSize_8b;	// 传输长度为8
    SPI_InitStruct.SPI_CPOL = SPI_CPOL_Low;	// 极性低，不支持mode3
    SPI_InitStruct.SPI_CPHA = SPI_CPHA_1Edge;	// 第一边沿采集
    SPI_InitStruct.SPI_FirstBit = SPI_FirstBit_MSB;	// MSB
    SPI_InitStruct.SPI_BaudRatePrescaler = SPI_BaudRatePrescaler_64;

    SPI_InitStruct.SPI_NSS = SPI_NSS_Soft;
    SPI_Init(SPI1, &SPI_InitStruct);
    SPI_NSSInternalSoftwareConfig(SPI1, SPI_NSSInternalSoft_Set);
}

void App_SPI_MasterTransmitReceive(SPI_TypeDef *SPIx,    // SPI的名称
                                    const uint8_t *pDataTx, // 要发送的数据
                                    uint8_t *pDataRx, // 接收到的数据
                                    uint16_t Size)  // 收发数据的数量
{
    SPI_Cmd(SPIx, ENABLE); // #1. 闭合总开关（使能SPI）
    SPI_I2S_SendData(SPIx, pDataTx[0]); // #2. 发送第一个字节

    // #3. 循环收发 Size-1 次数据
    for(uint16_t i=0; i<Size-1; i++)
    {
        // 发送一个字节：等待发送缓冲区空（TXE）
        while(SPI_I2S_GetFlagStatus(SPIx, SPI_I2S_FLAG_TXE) == RESET);
        SPI_I2S_SendData(SPIx, pDataTx[i+1]);
        
        // 接收一个字节：等待接收缓冲区非空（RXNE）
        while(SPI_I2S_GetFlagStatus(SPIx, SPI_I2S_FLAG_RXNE) == RESET);
        pDataRx[i] = SPI_I2S_ReceiveData(SPIx);
    }
    
    // #4. 读出最后一个字节
    while(SPI_I2S_GetFlagStatus(SPIx, SPI_I2S_FLAG_RXNE) == RESET);
    pDataRx[Size-1] = SPI_I2S_ReceiveData(SPIx);
    
    // #5. 断开总开关（失能SPI）
    SPI_Cmd(SPIx, DISABLE);
}

void App_W25Q64_SaveByte(uint8_t Byte)
{
    uint8_t buffer[10];

    // #1. 写使能
    buffer[0] = 0x06;
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_RESET); // 选中
    App_SPI_MasterTransmitReceive(SPI1, buffer, buffer, 1);
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_SET);   // 取消选中

    // #2. 扇区擦除（指令0x20 + 24位地址）
    buffer[0] = 0x20; // 扇区擦除指令
    buffer[1] = 0x00; // 地址高位（A23~A16）
    buffer[2] = 0x00; // 地址中位（A15~A8）
    buffer[3] = 0x00; // 地址低位（A7~A0）
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_RESET); // 选中芯片
    App_SPI_MasterTransmitReceive(SPI1, buffer, buffer, 4);
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_SET);   // 取消选中

    // #3. 等待空闲
    while(1)
    {
        GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_RESET); // 选中
        
        // 写0x05（读状态寄存器指令）
        buffer[0] = 0x05;
        App_SPI_MasterTransmitReceive(SPI1, buffer, buffer, 1);
        
        // 读状态寄存器1
        buffer[0] = 0xff;
        App_SPI_MasterTransmitReceive(SPI1, buffer, buffer, 1);
        
        GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_SET); // 取消选中
        if((buffer[0] & 0x01) == 0) break;
    }

    // #4. 写使能
    buffer[0] = 0x06;
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_RESET); // 选中
    App_SPI_MasterTransmitReceive(SPI1, buffer, buffer, 1);
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_SET);   // 取消选中
    
    // #5. 页编程
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_RESET); // 选中
    buffer[0] = 0x02;
    buffer[1] = 0x00;
    buffer[2] = 0x00;
    buffer[3] = 0x00;
    buffer[4] = Byte;
    App_SPI_MasterTransmitReceive(SPI1, buffer, buffer, 5);
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_SET);   // 取消选中

    // #6. 等待空闲
    while(1)
    {
        GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_RESET); // 选中
        
        // 写0x05（读状态寄存器指令）
        buffer[0] = 0x05;
        App_SPI_MasterTransmitReceive(SPI1, buffer, buffer, 1);
        
        // 读状态寄存器1
        buffer[0] = 0xff;
        App_SPI_MasterTransmitReceive(SPI1, buffer, buffer, 1);
        
        GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_SET); // 取消选中
        if((buffer[0] & 0x01) == 0) break;
    }
}

uint8_t App_W25Q64_LoadByte(void)
{
    uint8_t buffer[10];

    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_RESET); // 选中
    buffer[0] = 0x03;
    buffer[1] = 0x00;
    buffer[2] = 0x00;
    buffer[3] = 0x00;
    
    App_SPI_MasterTransmitReceive(SPI1, buffer, buffer, 4);
    
    buffer[0] = 0xff;
    App_SPI_MasterTransmitReceive(SPI1, buffer, buffer, 1);
    
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_SET); // 取消选中
    
    return buffer[0];
}

void App_OnBoardLED_Init(void)
{
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOC, ENABLE);

    GPIO_InitTypeDef GPIO_InitStruct;
    
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_13;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_Out_OD;
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_2MHz;
    GPIO_Init(GPIOC, &GPIO_InitStruct);
}

void button_clicked_cb(uint8_t clicks)
{
    if(clicks == 1)
    {
      if(GPIO_ReadOutputDataBit(GPIOC, GPIO_Pin_13) == Bit_SET)
      {
        GPIO_WriteBit(GPIOC, GPIO_Pin_13, Bit_RESET);
      }
      else
      {
        GPIO_WriteBit(GPIOC, GPIO_Pin_13, Bit_SET);
      }
    }
}

void App_Button_Init(void)
{
    Button_InitTypeDef Button_InitStruct = {0};

    Button_InitStruct.GPIOx = GPIOA;
    Button_InitStruct.GPIO_Pin = GPIO_Pin_0;
    Button_InitStruct.button_clicked_cb = button_clicked_cb;
    
    My_Button_Init(&button, &Button_InitStruct);
}
```

### 保存LED 的当前状态
#### button_clicked_cb
```c
void button_clicked_cb(uint8_t clicks;

void button_clicked_cb(uint8_t clicks)
{
    if(clicks == 1)
    {
      if(GPIO_ReadOutputDataBit(GPIOC, GPIO_Pin_13) == Bit_SET)
      {
        GPIO_WriteBit(GPIOC, GPIO_Pin_13, Bit_RESET);
        App_W25Q64_SaveByte(0x01);
      }
      else
      {
        GPIO_WriteBit(GPIOC, GPIO_Pin_13, Bit_SET);
        App_W25Q64_SaveByte(0x00);
      }
    }
}
```

### 恢复 LED 的状态
#### 完整实验代码
```c
#include "stm32f10x.h"
#include "delay.h"
#include "button.h"

Button_TypeDef button;

void App_SPI1_Init(void);
void App_SPI_MasterTransmitReceive(SPI_TypeDef *SPIx,    // SPI的名称
                                    const uint8_t *pDataTx, // 要发送的数据
                                    uint8_t *pDataRx, // 接收到的数据
                                    uint16_t Size);  // 收发数据的数量
void App_W25Q64_SaveByte(uint8_t Byte);
uint8_t App_W25Q64_LoadByte(void);
void App_OnBoardLED_Init(void);
void App_Button_Init(void);
void button_clicked_cb(uint8_t clicks);

int main(void)
{
    App_SPI1_Init();
    App_OnBoardLED_Init();
    App_Button_Init();

    uint8_t byte = App_W25Q64_LoadByte();

    if(byte == 0)
    {
        GPIO_WriteBit(GPIOC, GPIO_Pin_13, Bit_SET);
    }
    else
    {
        GPIO_WriteBit(GPIOC, GPIO_Pin_13, Bit_RESET);
    }

    while(1)
    {
        My_Button_Proc(&button);
    }
}

void App_SPI1_Init(void)
{
    // #1. 初始化IO引脚
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_AFIO, ENABLE);
    GPIO_PinRemapConfig(GPIO_Remap_SPI1, ENABLE);
    GPIO_PinRemapConfig(GPIO_Remap_SWJ_JTAGDisable, ENABLE);

    GPIO_InitTypeDef GPIO_InitStruct;

    // PB3 SCK AF_PP 2MHz // PB5 MOSI
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOB, ENABLE);
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_3 | GPIO_Pin_5;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_AF_PP;
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_2MHz;
    GPIO_Init(GPIOB, &GPIO_InitStruct);

    // PB4 MISO IPU
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOB, ENABLE);
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_4;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_IPU;
    GPIO_Init(GPIOB, &GPIO_InitStruct);

    // PA15 普通IO Out_PP 2MHz
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_15;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_Out_PP;
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_2MHz;
    GPIO_Init(GPIOA, &GPIO_InitStruct);
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_RESET);

    // #2. 对SPI本身进行初始化
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_SPI1, ENABLE);
    
    SPI_InitTypeDef SPI_InitStruct;

    SPI_InitStruct.SPI_Mode = SPI_Mode_Master;
    SPI_InitStruct.SPI_Direction = SPI_Direction_2Lines_FullDuplex;
    SPI_InitStruct.SPI_DataSize = SPI_DataSize_8b;	// 传输长度为8
    SPI_InitStruct.SPI_CPOL = SPI_CPOL_Low;	// 极性低，不支持mode3
    SPI_InitStruct.SPI_CPHA = SPI_CPHA_1Edge;	// 第一边沿采集
    SPI_InitStruct.SPI_FirstBit = SPI_FirstBit_MSB;	// MSB
    SPI_InitStruct.SPI_BaudRatePrescaler = SPI_BaudRatePrescaler_64;

    SPI_InitStruct.SPI_NSS = SPI_NSS_Soft;
    SPI_Init(SPI1, &SPI_InitStruct);
    SPI_NSSInternalSoftwareConfig(SPI1, SPI_NSSInternalSoft_Set);
}

void App_SPI_MasterTransmitReceive(SPI_TypeDef *SPIx,    // SPI的名称
                                    const uint8_t *pDataTx, // 要发送的数据
                                    uint8_t *pDataRx, // 接收到的数据
                                    uint16_t Size)  // 收发数据的数量
{
    SPI_Cmd(SPIx, ENABLE); // #1. 闭合总开关（使能SPI）
    SPI_I2S_SendData(SPIx, pDataTx[0]); // #2. 发送第一个字节

    // #3. 循环收发 Size-1 次数据
    for(uint16_t i=0; i<Size-1; i++)
    {
        // 发送一个字节：等待发送缓冲区空（TXE）
        while(SPI_I2S_GetFlagStatus(SPIx, SPI_I2S_FLAG_TXE) == RESET);
        SPI_I2S_SendData(SPIx, pDataTx[i+1]);
        
        // 接收一个字节：等待接收缓冲区非空（RXNE）
        while(SPI_I2S_GetFlagStatus(SPIx, SPI_I2S_FLAG_RXNE) == RESET);
        pDataRx[i] = SPI_I2S_ReceiveData(SPIx);
    }
    
    // #4. 读出最后一个字节
    while(SPI_I2S_GetFlagStatus(SPIx, SPI_I2S_FLAG_RXNE) == RESET);
    pDataRx[Size-1] = SPI_I2S_ReceiveData(SPIx);
    
    // #5. 断开总开关（失能SPI）
    SPI_Cmd(SPIx, DISABLE);
}

void App_W25Q64_SaveByte(uint8_t Byte)
{
    uint8_t buffer[10];

    // #1. 写使能
    buffer[0] = 0x06;
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_RESET); // 选中
    App_SPI_MasterTransmitReceive(SPI1, buffer, buffer, 1);
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_SET);   // 取消选中

    // #2. 扇区擦除（指令0x20 + 24位地址）
    buffer[0] = 0x20; // 扇区擦除指令
    buffer[1] = 0x00; // 地址高位（A23~A16）
    buffer[2] = 0x00; // 地址中位（A15~A8）
    buffer[3] = 0x00; // 地址低位（A7~A0）
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_RESET); // 选中芯片
    App_SPI_MasterTransmitReceive(SPI1, buffer, buffer, 4);
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_SET);   // 取消选中

    // #3. 等待空闲
    while(1)
    {
        GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_RESET); // 选中
        
        // 写0x05（读状态寄存器指令）
        buffer[0] = 0x05;
        App_SPI_MasterTransmitReceive(SPI1, buffer, buffer, 1);
        
        // 读状态寄存器1
        buffer[0] = 0xff;
        App_SPI_MasterTransmitReceive(SPI1, buffer, buffer, 1);
        
        GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_SET); // 取消选中
        if((buffer[0] & 0x01) == 0) break;
    }

    // #4. 写使能
    buffer[0] = 0x06;
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_RESET); // 选中
    App_SPI_MasterTransmitReceive(SPI1, buffer, buffer, 1);
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_SET);   // 取消选中
    
    // #5. 页编程
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_RESET); // 选中
    buffer[0] = 0x02;
    buffer[1] = 0x00;
    buffer[2] = 0x00;
    buffer[3] = 0x00;
    buffer[4] = Byte;
    App_SPI_MasterTransmitReceive(SPI1, buffer, buffer, 5);
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_SET);   // 取消选中

    // #6. 等待空闲
    while(1)
    {
        GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_RESET); // 选中
        
        // 写0x05（读状态寄存器指令）
        buffer[0] = 0x05;
        App_SPI_MasterTransmitReceive(SPI1, buffer, buffer, 1);
        
        // 读状态寄存器1
        buffer[0] = 0xff;
        App_SPI_MasterTransmitReceive(SPI1, buffer, buffer, 1);
        
        GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_SET); // 取消选中
        if((buffer[0] & 0x01) == 0) break;
    }
}

uint8_t App_W25Q64_LoadByte(void)
{
    uint8_t buffer[10];

    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_RESET); // 选中
    buffer[0] = 0x03;
    buffer[1] = 0x00;
    buffer[2] = 0x00;
    buffer[3] = 0x00;
    
    App_SPI_MasterTransmitReceive(SPI1, buffer, buffer, 4);
    
    buffer[0] = 0xff;
    App_SPI_MasterTransmitReceive(SPI1, buffer, buffer, 1);
    
    GPIO_WriteBit(GPIOA, GPIO_Pin_15, Bit_SET); // 取消选中
    
    return buffer[0];
}

void App_OnBoardLED_Init(void)
{
    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOC, ENABLE);

    GPIO_InitTypeDef GPIO_InitStruct;
    
    GPIO_InitStruct.GPIO_Pin = GPIO_Pin_13;
    GPIO_InitStruct.GPIO_Mode = GPIO_Mode_Out_OD;
    GPIO_InitStruct.GPIO_Speed = GPIO_Speed_2MHz;
    GPIO_Init(GPIOC, &GPIO_InitStruct);
}

void button_clicked_cb(uint8_t clicks)
{
    if(clicks == 1)
    {
      if(GPIO_ReadOutputDataBit(GPIOC, GPIO_Pin_13) == Bit_SET)
      {
        GPIO_WriteBit(GPIOC, GPIO_Pin_13, Bit_RESET);
        App_W25Q64_SaveByte(0x01);
      }
      else
      {
        GPIO_WriteBit(GPIOC, GPIO_Pin_13, Bit_SET);
        App_W25Q64_SaveByte(0x00);
      }
    }
}

void App_Button_Init(void)
{
    Button_InitTypeDef Button_InitStruct = {0};

    Button_InitStruct.GPIOx = GPIOA;
    Button_InitStruct.GPIO_Pin = GPIO_Pin_0;
    Button_InitStruct.button_clicked_cb = button_clicked_cb;
    
    My_Button_Init(&button, &Button_InitStruct);
}
```
